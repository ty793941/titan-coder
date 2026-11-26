import { describe, expect, it } from "vitest";
import { parseProductRoute, productRoute } from "../src/product/routes";

describe("正式产品路由", () => {
  it("默认进入我的决策", () => {
    expect(parseProductRoute("")).toEqual({ name: "inbox" });
  });

  it("支持项目和决策深链接", () => {
    expect(parseProductRoute("#/projects/project-1")).toEqual({
      name: "project",
      projectId: "project-1",
    });
    expect(parseProductRoute("#/decisions/decision-1")).toEqual({
      name: "decision",
      decisionId: "decision-1",
    });
    expect(productRoute({ name: "project", projectId: "project-1" })).toBe(
      "#/projects/project-1",
    );
  });

  it("把验收控制台放在明确的开发入口", () => {
    expect(parseProductRoute("#/acceptance")).toEqual({ name: "acceptance" });
    expect(parseProductRoute("#/acceptance?run=run-1")).toEqual({
      name: "acceptance",
      runId: "run-1",
    });
    expect(parseProductRoute("#/projects")).toEqual({ name: "projects" });
    expect(parseProductRoute("#/unexpected")).toEqual({ name: "inbox" });
  });
});
