import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
});

describe("GitHub API base URL", () => {
  it("defaults to public GitHub", async () => {
    const { GITHUB_API_BASE_URL, GITHUB_API_ORIGIN } = await import("../api.js");
    expect(GITHUB_API_BASE_URL).toBe("https://api.github.com");
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
  });

  it("uses the configured enterprise API origin", async () => {
    const api = await import("./github-api.js");
    api.configureGitHubApi("https://api.ghe.example.test/");
    expect(api.GITHUB_API_BASE_URL).toBe("https://api.ghe.example.test");
    expect(api.GITHUB_API_ORIGIN).toBe("https://api.github.com");
  });

  it("routes Enterprise Server REST and GraphQL requests to their API paths", async () => {
    const api = await import("./github-api.js");
    api.configureGitHubApi("https://ghe.example.test/api/v3/");
    const { fetchGitHubApi, GITHUB_API_BASE_URL, GITHUB_GRAPHQL_URL } = api;
    expect(GITHUB_API_BASE_URL).toBe("https://ghe.example.test/api/v3");
    expect(GITHUB_GRAPHQL_URL).toBe("https://ghe.example.test/api/graphql");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    await fetchGitHubApi(
      `${GITHUB_API_BASE_URL}/repos/acme/private-repo`,
      fetchImpl,
      "synthetic-token",
    );
    await fetchGitHubApi(
      GITHUB_GRAPHQL_URL,
      fetchImpl,
      "synthetic-token",
      undefined,
      undefined,
      undefined,
      undefined,
      { query: "query { viewer { login } }", variables: {} },
    );
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://ghe.example.test/api/v3/repos/acme/private-repo",
      "https://ghe.example.test/api/graphql",
    ]);
    await expect(
      fetchGitHubApi("https://ghe.example.test/settings", fetchImpl, "synthetic-token"),
    ).rejects.toThrow("Invalid GitHub API URL");
  });

  it("keeps a configured HTTPS API port on Enterprise requests", async () => {
    const api = await import("./github-api.js");
    api.configureGitHubApi("https://ghe.example.test:8443/api/v3");
    const { fetchGitHubApi, GITHUB_API_BASE_URL } = api;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    await fetchGitHubApi(`${GITHUB_API_BASE_URL}/repos/acme/private-repo`, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ghe.example.test:8443/api/v3/repos/acme/private-repo",
      expect.any(Object),
    );
    await expect(
      fetchGitHubApi("https://ghe.example.test/api/v3/repos/acme/private-repo", fetchImpl),
    ).rejects.toThrow("Invalid GitHub API URL");
  });

  it.each([
    "http://api.ghe.example.test",
    "https://user@example.com",
    "https://api.ghe.example.test/other",
  ])("rejects unsafe configured API origin %s", async (origin) => {
    const api = await import("./github-api.js");
    expect(() => api.configureGitHubApi(origin)).toThrow(
      "gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL",
    );
  });
});
