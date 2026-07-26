import { describe, expect, it } from "vitest";
import {
  providerSettingsSchema,
  startChatRequestSchema,
  workspaceDirSchema,
} from "./schemas";

describe("providerSettingsSchema", () => {
  it("accepts a valid payload with an apiKey", () => {
    const result = providerSettingsSchema.safeParse({
      apiKey: "sk-fake-test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    expect(result.success).toBe(true);
    expect(result.data?.apiKey).toBe("sk-fake-test-key");
    expect(result.data?.model).toBe("gpt-4o-mini");
  });

  it("accepts a valid payload with apiKey omitted (optional)", () => {
    const result = providerSettingsSchema.safeParse({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    expect(result.success).toBe(true);
    expect(result.data?.apiKey).toBeUndefined();
  });

  it("rejects a payload with an empty apiKey string", () => {
    const result = providerSettingsSchema.safeParse({
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a payload with a malformed baseUrl", () => {
    const result = providerSettingsSchema.safeParse({
      apiKey: "sk-fake-test-key",
      baseUrl: "not-a-valid-url",
      model: "gpt-4o-mini",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("baseUrl"))).toBe(true);
    }
  });

  it("rejects a payload with an empty model id", () => {
    const result = providerSettingsSchema.safeParse({
      baseUrl: "https://api.openai.com/v1",
      model: "",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("model"))).toBe(true);
    }
  });

  it("rejects a payload missing required fields entirely", () => {
    const result = providerSettingsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("startChatRequestSchema", () => {
  const validRequest = {
    conversationId: "conv-1",
    model: "app-settings/gpt-4o-mini",
    messages: [{ role: "user", content: "hello" }],
  };

  it("accepts a valid request with a single user message", () => {
    const result = startChatRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
    expect(result.data?.messages).toHaveLength(1);
    expect(result.data?.conversationId).toBe("conv-1");
  });

  it("accepts all three valid role values", () => {
    for (const role of ["user", "assistant", "system"] as const) {
      const result = startChatRequestSchema.safeParse({
        ...validRequest,
        messages: [{ role, content: "hi" }],
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an empty conversationId", () => {
    const result = startChatRequestSchema.safeParse({
      ...validRequest,
      conversationId: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty model id", () => {
    const result = startChatRequestSchema.safeParse({
      ...validRequest,
      model: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message with an invalid role", () => {
    const result = startChatRequestSchema.safeParse({
      ...validRequest,
      messages: [{ role: "bogus-role", content: "hi" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a message missing content", () => {
    const result = startChatRequestSchema.safeParse({
      ...validRequest,
      messages: [{ role: "user" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload where messages is not an array", () => {
    const result = startChatRequestSchema.safeParse({
      ...validRequest,
      messages: "not-an-array",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty messages array (no minimum length enforced)", () => {
    const result = startChatRequestSchema.safeParse({
      ...validRequest,
      messages: [],
    });
    expect(result.success).toBe(true);
    expect(result.data?.messages).toEqual([]);
  });
});

describe("workspaceDirSchema", () => {
  it("accepts a non-empty string", () => {
    const result = workspaceDirSchema.safeParse("/home/user/project");
    expect(result.success).toBe(true);
    expect(result.data).toBe("/home/user/project");
  });

  it("rejects an empty string", () => {
    const result = workspaceDirSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects a non-string value", () => {
    const result = workspaceDirSchema.safeParse(12345);
    expect(result.success).toBe(false);
  });
});
