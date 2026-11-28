// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { defineComponent } from "vue";
import { expect, it, vi } from "vitest";
import { api } from "../src/api";
import { useProductData } from "../src/product/useProductData";
import type { ConsoleState } from "../src/types";

it("提案确认期间已有刷新时，再读取一次新事实并等待完成再导航", async () => {
  const oldState: ConsoleState = {
    projects: [],
    tasks: [],
    sessions: [],
    runs: [],
    daemons: [],
  };
  const newState: ConsoleState = {
    ...oldState,
    projects: [{ id: "new-project", name: "新项目", goal: "目标" }],
  };
  let release!: (state: ConsoleState) => void;
  const first = new Promise<ConsoleState>((resolve) => {
    release = resolve;
  });
  const state = vi
    .spyOn(api, "state")
    .mockReturnValueOnce(first)
    .mockResolvedValue(newState);
  vi.spyOn(api, "localStatus").mockRejectedValue(new Error("offline"));
  let product!: ReturnType<typeof useProductData>;
  const wrapper = mount(
    defineComponent({
      setup() {
        product = useProductData();
        return () => null;
      },
    }),
  );
  expect(state).toHaveBeenCalledTimes(1);
  const afterMutation = product.refresh();
  release(oldState);
  await afterMutation;
  await flushPromises();
  expect(state).toHaveBeenCalledTimes(2);
  expect(product.state.value.projects).toEqual(newState.projects);
  wrapper.unmount();
});
