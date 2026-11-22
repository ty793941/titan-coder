// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import CredentialCard from "../src/components/CredentialCard.vue";
import { api } from "../src/api";

describe("credential entry", () => {
  it("clears a submitted key and waits for refreshed metadata instead of claiming model verification", async () => {
    vi.spyOn(api, "saveCredential").mockResolvedValue({
      configured: true,
      credentialRef: "keychain://titan-qwen",
    });
    const wrapper = mount(CredentialCard, {
      props: {
        provider: "qwen",
        csrfToken: "csrf",
        credential: {
          provider: "qwen",
          configured: false,
          credentialRef: "keychain://titan-qwen",
        },
      },
    });
    await wrapper.get('input[type="password"]').setValue("a-test-only-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(
      (wrapper.get('input[type="password"]').element as HTMLInputElement).value,
    ).toBe("");
    expect(wrapper.text()).not.toContain("a-test-only-key");
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("模型验证成功");
    wrapper.unmount();
  });
  it("clears the key on failure and does not emit a false configured state", async () => {
    vi.spyOn(api, "saveCredential").mockRejectedValue(
      new Error("backend failed"),
    );
    const wrapper = mount(CredentialCard, {
      props: { provider: "codex", csrfToken: "csrf" },
    });
    await wrapper
      .get('input[type="password"]')
      .setValue("another-test-only-key");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(
      (wrapper.get('input[type="password"]').element as HTMLInputElement).value,
    ).toBe("");
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.emitted("changed")).toBeUndefined();
    wrapper.unmount();
  });
});
