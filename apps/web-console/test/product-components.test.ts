// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import ProductShell from "../src/components/product/ProductShell.vue";
import DecisionInbox from "../src/components/product/DecisionInbox.vue";
import type { ProductDecision } from "../src/product/types";

const decision: ProductDecision = {
  id: "review_artifact:questions-1",
  type: "review_artifact",
  priority: "high",
  projectId: "project-1",
  taskId: "task-1",
  title: "审阅问题确认",
  summary: "支付平台中的结算接口有一个版本等待判断。",
  whyNow: "后续阶段需要这次确认。",
  recommendation: "先审阅依据，再批准或要求修改。",
  impact: "批准后可继续推进。",
  actionLabel: "批准问题确认",
  artifactId: "questions-1",
  createdAt: "2026-11-26T10:00:00Z",
};

describe("正式产品首页", () => {
  it("显示面向项目负责人的导航和决策入口", () => {
    const wrapper = mount(ProductShell, {
      props: {
        route: { name: "inbox" },
        decisions: [decision],
        projects: [{ id: "project-1", name: "支付平台", goal: "交付重构" }],
        loading: false,
        error: "",
        lastSync: "2026-11-26T10:00:00Z",
      },
      slots: { default: "首页内容" },
    });
    expect(wrapper.text()).toContain("我的决策");
    expect(wrapper.text()).toContain("项目");
    expect(wrapper.text()).toContain("交付物");
    expect(wrapper.text()).toContain("活动");
    expect(wrapper.text()).not.toContain("LOCAL");
    expect(wrapper.text()).not.toContain("EXECUTION ENGINE");
  });

  it("展示决策队列和唯一主操作", () => {
    const wrapper = mount(DecisionInbox, {
      props: {
        decisions: [decision],
        projects: [{ id: "project-1", name: "支付平台", goal: "交付重构" }],
        loading: false,
      },
    });
    expect(wrapper.text()).toContain("今天要决定的事");
    expect(wrapper.text()).toContain("处理此事项");
    expect(wrapper.findAll("button.product-primary-action")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("凭证");
  });

  it("没有决策时显示正式产品空状态", () => {
    const wrapper = mount(DecisionInbox, {
      props: { decisions: [], projects: [], loading: false },
    });
    expect(wrapper.text()).toContain("当前没有需要你决定的事项");
  });
});
