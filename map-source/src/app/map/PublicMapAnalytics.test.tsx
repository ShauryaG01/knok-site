import { render, waitFor } from "@testing-library/react";
import { PublicMapAnalytics } from "./PublicMapAnalytics";
import { hasAnalyticsConsent, setAnalyticsConsent, track, trackOnce } from "@/lib/analytics";
import { initializePublicAnalytics } from "@/lib/publicAnalytics";

jest.mock("@/lib/analytics", () => ({
  hasAnalyticsConsent: jest.fn(),
  setAnalyticsConsent: jest.fn(),
  track: jest.fn(),
  trackOnce: jest.fn(),
}));
jest.mock("@/lib/publicAnalytics", () => ({
  capturePublicAnalytics: jest.fn(),
  initializePublicAnalytics: jest.fn(() => Promise.resolve()),
  PUBLIC_ANALYTICS_EVENT: "knok:public-analytics",
}));

const mockAnalytics = {
  hasAnalyticsConsent: jest.mocked(hasAnalyticsConsent),
  setAnalyticsConsent: jest.mocked(setAnalyticsConsent),
  track: jest.mocked(track),
  trackOnce: jest.mocked(trackOnce),
};
const mockPublicAnalytics = {
  initializePublicAnalytics: jest.mocked(initializePublicAnalytics),
};

describe("PublicMapAnalytics", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.clearAllMocks();
    mockAnalytics.hasAnalyticsConsent.mockReturnValue(false);
    mockPublicAnalytics.initializePublicAnalytics.mockResolvedValue(undefined);
  });

  it("starts public analytics for a new visitor without a consent banner", async () => {
    render(<PublicMapAnalytics totalCompanies={742} />);

    await waitFor(() => expect(mockPublicAnalytics.initializePublicAnalytics).toHaveBeenCalledTimes(1));
    expect(mockAnalytics.setAnalyticsConsent).toHaveBeenCalledWith(true);
    expect(mockAnalytics.track).toHaveBeenCalledWith("page_view");
    expect(mockAnalytics.trackOnce).toHaveBeenCalledWith("map_viewed", {
      city: "bengaluru",
      total: 742,
    });
  });

  it("respects a prior explicit opt-out", async () => {
    window.localStorage.setItem("knok-analytics-consent", "0");
    render(<PublicMapAnalytics totalCompanies={742} />);

    await Promise.resolve();
    expect(mockPublicAnalytics.initializePublicAnalytics).not.toHaveBeenCalled();
    expect(mockAnalytics.setAnalyticsConsent).not.toHaveBeenCalled();
  });
});
