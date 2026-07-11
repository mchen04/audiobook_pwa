import { beforeEach, describe, expect, it, vi } from "vitest";

const mockedEnv = vi.hoisted(() => ({
  RESEND_API_KEY: undefined as string | undefined,
  MAIL_FROM: undefined as string | undefined,
  ALLOW_LOCAL_MAIL_CAPTURE: undefined as string | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/env", () => ({ env: mockedEnv }));

import { assertPasswordResetDeliveryConfigured } from "./password-reset";

describe("password reset delivery configuration", () => {
  beforeEach(() => {
    mockedEnv.RESEND_API_KEY = undefined;
    mockedEnv.MAIL_FROM = undefined;
  });

  it("allows the app to start when password reset delivery is disabled", () => {
    expect(() => assertPasswordResetDeliveryConfigured()).not.toThrow();
  });

  it("accepts a complete Resend configuration", () => {
    mockedEnv.RESEND_API_KEY = "re_test";
    mockedEnv.MAIL_FROM = "Chapterline <noreply@example.com>";

    expect(() => assertPasswordResetDeliveryConfigured()).not.toThrow();
  });

  it.each([
    ["re_test", undefined],
    [undefined, "Chapterline <noreply@example.com>"],
  ])("rejects a partial Resend configuration", (apiKey, mailFrom) => {
    mockedEnv.RESEND_API_KEY = apiKey;
    mockedEnv.MAIL_FROM = mailFrom;

    expect(() => assertPasswordResetDeliveryConfigured()).toThrow(
      "Password reset email requires both RESEND_API_KEY and MAIL_FROM.",
    );
  });
});
