// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { AgentActivity } from "./AgentActivity";
import type { Activity } from "../state/chat-store";

afterEach(() => cleanup());

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: "call-1",
    toolName: "web_search",
    label: "Searched the web",
    args: {},
    status: "done",
    durationMs: 500,
    ...overrides,
  };
}

describe("AgentActivity complete footer", () => {
  it("shows just the activity summary, with no step-count prefix, when no activity has sources", () => {
    render(<AgentActivity activity={[makeActivity()]} />);
    expect(screen.getByText("Searched the web")).toBeTruthy();
    expect(screen.queryByText(/step/)).toBeNull();
    expect(screen.queryByText(/source/)).toBeNull();
  });

  it("leads with the source count when one activity has one source", () => {
    render(
      <AgentActivity
        activity={[makeActivity({ sources: [{ title: "MDN", url: "https://developer.mozilla.org" }] })]}
      />,
    );
    expect(screen.getByText("Searched the web · 1 source")).toBeTruthy();
    expect(screen.queryByText(/1 step/)).toBeNull();
  });

  it("pluralizes and sums sources across multiple activities", () => {
    render(
      <AgentActivity
        activity={[
          makeActivity({ id: "call-1", sources: [{ title: "MDN", url: "https://developer.mozilla.org" }] }),
          makeActivity({
            id: "call-2",
            label: "Searched the web",
            sources: [{ title: "Wiki", url: "https://wikipedia.org" }],
          }),
        ]}
      />,
    );
    expect(screen.getByText("Searched the web · 2 sources")).toBeTruthy();
  });

  it("still shows the failure footer when an activity errored, regardless of sources", () => {
    render(
      <AgentActivity
        activity={[
          makeActivity({ status: "error" }),
          makeActivity({ id: "call-2", sources: [{ title: "MDN", url: "https://developer.mozilla.org" }] }),
        ]}
      />,
    );
    expect(screen.getByText(/2 steps · 1 failed/)).toBeTruthy();
    expect(screen.queryByText(/source/)).toBeNull();
  });
});
