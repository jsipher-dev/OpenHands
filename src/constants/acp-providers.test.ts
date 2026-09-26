import { ACP_PROVIDERS as CLIENT_ACP_PROVIDERS } from "@openhands/typescript-client";
import { describe, expect, it } from "vitest";
import {
  ACP_LOCAL_PROVIDER_INFO,
  ACP_MANAGED_SENTINEL,
  ACP_PROVIDERS,
  getAcpProviderSecrets,
  SURFACED_ACP_PROVIDERS,
  resolveEffectiveAcpModel,
} from "./acp-providers";

describe("ACP_PROVIDERS", () => {
  it("passes every codex data field through from the pinned client registry", () => {
    // No local override may sit between the registry and the picker: a
    // hand-maintained model entry survives an upstream *removal*, so Canvas
    // would keep offering an id the live ACP server has started rejecting.
    const codex = ACP_PROVIDERS.find(({ key }) => key === "codex");
    const client = CLIENT_ACP_PROVIDERS.codex;
    expect(codex?.default_command).toEqual([...client.default_command]);
    expect(codex?.available_models).toEqual(
      client.available_models.map(({ id, label }) => ({ id, label })),
    );
  });

  it("carries GPT-6 Astra, so the pin is new enough to launch it", () => {
    // Canary for the pin's freshness, not a catalog Canvas maintains: Astra
    // needs codex-acp >= 1.10.0, which only client >= 1.45.0 mirrors.
    const codex = ACP_PROVIDERS.find(({ key }) => key === "codex");
    expect(codex?.available_models?.map(({ id }) => id)).toContain(
      "gpt-6-astra",
    );
  });
});

describe("resolveEffectiveAcpModel", () => {
  it("surfaces the real claude-agent-acp 0.44+ 'default' model", () => {
    // ``default`` ("Default (recommended)") is a real, selectable Claude model
    // in the configOptions select — the server reports it as the current model.
    // It must NOT be suppressed as a placeholder (regression: the chip would
    // otherwise show no model for a session genuinely running on 'default').
    expect(resolveEffectiveAcpModel({ runtimeId: "default" })).toBe("default");
    expect(
      resolveEffectiveAcpModel({ runtimeName: "Default (recommended)" }),
    ).toBe("Default (recommended)");
  });

  it("follows the runtime → configured → sdkLlm precedence", () => {
    expect(
      resolveEffectiveAcpModel({
        runtimeName: "Sonnet",
        runtimeId: "sonnet",
        configured: "haiku",
      }),
    ).toBe("Sonnet");
    expect(resolveEffectiveAcpModel({ configured: "haiku" })).toBe("haiku");
    expect(resolveEffectiveAcpModel({ sdkLlm: "gpt-5.5/medium" })).toBe(
      "gpt-5.5/medium",
    );
  });

  it("still suppresses the legacy acp-managed sentinel and blanks", () => {
    expect(
      resolveEffectiveAcpModel({ sdkLlm: ACP_MANAGED_SENTINEL }),
    ).toBeNull();
    expect(resolveEffectiveAcpModel({ runtimeId: "   " })).toBeNull();
    expect(resolveEffectiveAcpModel({})).toBeNull();
  });

  it("falls back to providerDefault only when no concrete model resolves", () => {
    expect(
      resolveEffectiveAcpModel({
        sdkLlm: ACP_MANAGED_SENTINEL,
        providerDefault: "opus[1m]",
      }),
    ).toBe("opus[1m]");
    // A real 'default' wins over providerDefault — it is a concrete model.
    expect(
      resolveEffectiveAcpModel({
        runtimeId: "default",
        providerDefault: "opus[1m]",
      }),
    ).toBe("default");
  });
});

describe("surfaced ACP providers", () => {
  // A surfaced provider's data (command, models, credential fields) resolves
  // from either the pinned client registry or a locally-carried fallback
  // (ACP_LOCAL_PROVIDER_INFO) for providers the client doesn't mirror yet.
  const resolvable = (key: string) =>
    key in CLIENT_ACP_PROVIDERS || key in ACP_LOCAL_PROVIDER_INFO;

  // Everything the pinned client registry publishes that Canvas does not
  // offer. Derived, so a harness added upstream is covered here without an
  // edit — the point of declaring what we surface rather than what we hide.
  const unsurfaced = Object.keys(CLIENT_ACP_PROVIDERS).filter(
    (key) => !SURFACED_ACP_PROVIDERS.includes(key),
  );

  it("surfaces Claude Code, Codex, Gemini CLI and Kiro CLI", () => {
    expect([...SURFACED_ACP_PROVIDERS]).toEqual([
      "claude-code",
      "codex",
      "gemini-cli",
      "kiro-cli",
    ]);
  });

  it("resolves every surfaced provider from the client or a local fallback", () => {
    // A rename or removal upstream must break loudly rather than leave a tile
    // whose command and models resolve to nothing. Providers the client
    // doesn't mirror yet (Kiro CLI) must be carried in ACP_LOCAL_PROVIDER_INFO.
    // An addition to the client registry stays a no-op.
    expect(SURFACED_ACP_PROVIDERS.filter((key) => !resolvable(key))).toEqual(
      [],
    );
  });

  it("carries a real launch command for a locally-shimmed provider", () => {
    // Guards the failure mode the client-only lookup used to hit for Kiro: an
    // empty default_command that would spawn nothing.
    const kiro = ACP_PROVIDERS.find(({ key }) => key === "kiro-cli");
    expect(kiro?.display_name).toBe("Kiro CLI");
    expect(kiro?.default_command).toEqual(["kiro-cli", "acp"]);
  });

  it("offers the API-key field for a locally-shimmed provider", () => {
    // getAcpProviderSecrets must not early-return [] for Kiro just because the
    // pinned client has no entry — the local fallback supplies KIRO_API_KEY.
    expect(getAcpProviderSecrets("kiro-cli")).toEqual([
      expect.objectContaining({ name: "KIRO_API_KEY", secret: true }),
    ]);
  });

  it("offers no credential fields for a harness it does not surface", () => {
    unsurfaced.forEach((key) => {
      expect(getAcpProviderSecrets(key)).toEqual([]);
    });
  });
});
