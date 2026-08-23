import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MapJobAlertPrompt } from "./MapJobAlertPrompt";

jest.mock("@/lib/analytics", () => ({ track: jest.fn() }));

describe("MapJobAlertPrompt", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
    global.fetch = jest.fn();
  });

  it("requires a valid email before calling the capture endpoint", () => {
    const fetchSpy = global.fetch as jest.Mock;
    render(<MapJobAlertPrompt roleTarget="Product Manager" searchQuery="" engaged={false} />);
    fireEvent.click(screen.getByRole("button", { name: /job alerts/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "not-an-email" } });
    fireEvent.click(screen.getByRole("button", { name: /create my alert/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/valid email/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("submits explicit email consent and shows a success state", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    render(<MapJobAlertPrompt roleTarget="Growth" searchQuery="fintech" engaged={false} />);
    fireEvent.click(screen.getByRole("button", { name: /job alerts/i }));
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: "person@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /create my alert/i }));

    await waitFor(() => expect(screen.getByText(/we’ll keep an eye on bengaluru/i)).toBeTruthy());
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("public-map-alerts"), expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"role_target":"Growth"'),
    }));
    expect(window.localStorage.getItem("knok-map-alert-subscribed")).toBe("1");
  });
});
