// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ArtifactEditor from "../src/components/ArtifactEditor.vue";
import { api } from "../src/api";
import type { Artifact } from "../src/types";

const artifact: Artifact = {
  artifactId: "q-1",
  type: "questions",
  version: 1,
  checksum: "sha256:fixture",
  uri: "file:///tmp/questions.md",
  sourceArtifacts: [],
  reviewState: "pending",
  status: "draft",
};
describe("explicit artifact review", () => {
  it("does not approve when saving a draft, and requires a separate human click", async () => {
    vi.spyOn(api, "createArtifact").mockResolvedValue(artifact);
    const approve = vi
      .spyOn(api, "approveArtifact")
      .mockResolvedValue({ ...artifact, reviewState: "approved" });
    vi.spyOn(api, "content").mockResolvedValue({
      content: "# Questions",
      checksum: "sha256:fixture",
      bytes: 11,
      format: "markdown",
    });
    const wrapper = mount(ArtifactEditor, {
      props: { taskId: "task-1", type: "questions", artifacts: [] },
    });
    await wrapper.get("textarea").setValue("# Questions");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(approve).not.toHaveBeenCalled();
    await wrapper.setProps({ artifacts: [artifact] });
    await flushPromises();
    await wrapper.get('[data-action="approve"]').trigger("click");
    await flushPromises();
    expect(approve).toHaveBeenCalledWith("q-1");
    wrapper.unmount();
  });
  it("renders artifact HTML as text and blocks approval of unsaved edits", async () => {
    vi.spyOn(api, "content").mockResolvedValue({
      content: '<img src=x onerror="alert(1)">',
      checksum: "sha256:fixture",
      bytes: 31,
      format: "markdown",
    });
    const wrapper = mount(ArtifactEditor, {
      props: { taskId: "task-1", type: "questions", artifacts: [artifact] },
    });
    await flushPromises();
    expect(wrapper.find("img").exists()).toBe(false);
    await wrapper.get("textarea").setValue("changed");
    expect(
      wrapper.get('[data-action="approve"]').attributes("disabled"),
    ).toBeDefined();
    wrapper.unmount();
  });

  it("blocks approval when the returned content checksum differs from the selected artifact metadata", async () => {
    vi.spyOn(api, "content").mockResolvedValue({
      content: "different content",
      checksum: "sha256:different",
      bytes: 17,
      format: "markdown",
    });
    const approve = vi.spyOn(api, "approveArtifact");
    const wrapper = mount(ArtifactEditor, {
      props: { taskId: "task-1", type: "questions", artifacts: [artifact] },
    });
    await flushPromises();
    expect(
      wrapper.get('[data-action="approve"]').attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(approve).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
