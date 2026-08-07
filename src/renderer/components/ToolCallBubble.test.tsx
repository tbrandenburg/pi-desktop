// @vitest-environment jsdom

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ToolCallBubble } from "./ToolCallBubble";

describe("ToolCallBubble", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the tool name but hides arguments when collapsed", () => {
    render(<ToolCallBubble toolName="read_file" arguments={{ path: "/tmp/foo.txt" }} expanded={false} />);

    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.queryByText(/tmp\/foo\.txt/)).toBeNull();
  });

  it("renders pretty-printed arguments when expanded", () => {
    render(<ToolCallBubble toolName="read_file" arguments={{ path: "/tmp/foo.txt" }} expanded={true} />);

    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText(/tmp\/foo\.txt/)).toBeTruthy();
  });
});
