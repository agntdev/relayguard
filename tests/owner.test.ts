import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getOwnerId, setOwnerIdOverride } from "../src/owner.js";

describe("owner ID resolution", () => {
  const REAL_OWNER_ID = process.env.OWNER_ID;
  const REAL_BUILD_METADATA = process.env.BUILD_METADATA;

  beforeEach(() => {
    delete process.env.OWNER_ID;
    delete process.env.BUILD_METADATA;
    setOwnerIdOverride(undefined);
  });

  afterEach(() => {
    // Restore original env
    if (REAL_OWNER_ID !== undefined) process.env.OWNER_ID = REAL_OWNER_ID;
    else delete process.env.OWNER_ID;
    if (REAL_BUILD_METADATA !== undefined) process.env.BUILD_METADATA = REAL_BUILD_METADATA;
    else delete process.env.BUILD_METADATA;
    setOwnerIdOverride(undefined);
  });

  it("returns null when no owner source is configured", () => {
    expect(getOwnerId()).toBeNull();
  });

  it("reads OWNER_ID from env var", () => {
    process.env.OWNER_ID = "42";
    expect(getOwnerId()).toBe(42);
  });

  it("reads from BUILD_METADATA when OWNER_ID is not set", () => {
    process.env.BUILD_METADATA = JSON.stringify({ OWNER_TELEGRAM_ID: "99" });
    expect(getOwnerId()).toBe(99);
  });

  it("prefers OWNER_ID over BUILD_METADATA", () => {
    process.env.OWNER_ID = "42";
    process.env.BUILD_METADATA = JSON.stringify({ OWNER_TELEGRAM_ID: "99" });
    expect(getOwnerId()).toBe(42);
  });

  it("returns null for invalid OWNER_ID value", () => {
    process.env.OWNER_ID = "not-a-number";
    expect(getOwnerId()).toBeNull();
  });

  it("reads from setOwnerIdOverride when set", () => {
    setOwnerIdOverride(() => 77);
    expect(getOwnerId()).toBe(77);
  });

  it("restores real resolution after setOwnerIdOverride(undefined)", () => {
    setOwnerIdOverride(() => 77);
    expect(getOwnerId()).toBe(77);
    setOwnerIdOverride(undefined);
    expect(getOwnerId()).toBeNull();
  });

  it("returns null for invalid BUILD_METADATA JSON", () => {
    process.env.BUILD_METADATA = "not-json";
    expect(getOwnerId()).toBeNull();
  });

  it("returns null when BUILD_METADATA lacks OWNER_TELEGRAM_ID", () => {
    process.env.BUILD_METADATA = JSON.stringify({ other: "value" });
    expect(getOwnerId()).toBeNull();
  });
});