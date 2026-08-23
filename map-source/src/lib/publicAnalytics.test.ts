describe("public analytics", () => {
  beforeEach(() => {
    jest.resetModules();
    document.head.innerHTML = "";
    delete window.dataLayer;
    delete window.gtag;
    delete window.clarity;
    delete process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  });

  it("uses the native arguments queue required by Google Tag", async () => {
    const { initializePublicAnalytics } = await import("./publicAnalytics");

    await initializePublicAnalytics();

    expect(document.querySelector<HTMLScriptElement>("#knok-ga4")?.src).toContain(
      "googletagmanager.com/gtag/js?id=G-PPJ6D8NBTQ",
    );
    expect(window.dataLayer).toHaveLength(4);
    expect(Array.isArray(window.dataLayer?.[0])).toBe(false);
    expect(Object.prototype.toString.call(window.dataLayer?.[0])).toBe("[object Arguments]");
    expect(Array.from(window.dataLayer?.[0] as IArguments)).toEqual([
      "consent",
      "default",
      expect.objectContaining({ analytics_storage: "denied" }),
    ]);
    expect(Array.from(window.dataLayer?.[3] as IArguments)).toEqual([
      "config",
      "G-PPJ6D8NBTQ",
      expect.objectContaining({ send_page_view: false }),
    ]);
  });

  it("queues an explicit page view after analytics is enabled", async () => {
    const { capturePublicAnalytics, initializePublicAnalytics } = await import("./publicAnalytics");
    await initializePublicAnalytics();

    capturePublicAnalytics({ event: "page_view", route: "/map", properties: {} });

    const command = Array.from(window.dataLayer?.at(-1) as IArguments);
    expect(command).toEqual([
      "event",
      "page_view",
      expect.objectContaining({ page_path: "/map" }),
    ]);
  });

  it("does not hold Google Analytics behind PostHog startup", async () => {
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN = "phc_test";
    jest.doMock("posthog-js", () => {
      throw new Error("PostHog unavailable");
    });
    const { capturePublicAnalytics, initializePublicAnalytics } = await import("./publicAnalytics");

    await expect(initializePublicAnalytics()).resolves.toBeUndefined();
    capturePublicAnalytics({ event: "map_viewed", route: "/map", properties: { city: "bengaluru" } });

    expect(Array.from(window.dataLayer?.at(-1) as IArguments)).toEqual([
      "event",
      "map_viewed",
      expect.objectContaining({ city: "bengaluru" }),
    ]);
  });
});
