import { describe, expect, it } from "vitest";
import {
  latestArtifact,
  approvedChain,
  runBlocker,
  upstreamFor,
} from "../src/workflow";
import type { Artifact } from "../src/types";

function artifact(
  type: string,
  version: number,
  sourceArtifacts: string[] = [],
  reviewState: Artifact["reviewState"] = "approved",
): Artifact {
  return {
    artifactId: `${type}-${version}`,
    type,
    version,
    checksum: `sha256:${type}-${version}`,
    sourceArtifacts,
    reviewState,
    status: reviewState === "approved" ? "approved" : "draft",
    uri: "file:///tmp/fixture.md",
  };
}
const chain = () => [
  artifact("questions", 1),
  artifact("research", 1, ["questions-1"]),
  artifact("design", 1, ["research-1"]),
  artifact("structure", 1, ["design-1"]),
  artifact("plan", 1, ["structure-1"]),
];

describe("human approval gates", () => {
  it("does not fall back to an old approved plan when a newer draft exists", () => {
    const items = [...chain(), artifact("plan", 2, ["structure-1"], "pending")];
    expect(latestArtifact(items, "plan")?.artifactId).toBe("plan-2");
    expect(approvedChain(items)).toBe(false);
    expect(runBlocker("implement", items, true, true)).toBeTruthy();
  });
  it("invalidates downstream approval if an upstream version changed", () => {
    const items = [...chain(), artifact("research", 2, ["questions-1"])];
    expect(approvedChain(items)).toBe(false);
    expect(upstreamFor(items, "design")?.artifactId).toBe("research-2");
  });
  it("permits run creation only at implementation with approved current chain and a configured local environment", () => {
    expect(runBlocker("implement", chain(), true, true)).toBe("");
    expect(runBlocker("plan", chain(), true, true)).toBeTruthy();
    expect(runBlocker("implement", chain(), false, true)).toBeTruthy();
    expect(runBlocker("implement", chain(), true, false)).toBeTruthy();
  });
});
