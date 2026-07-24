import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsNotifications } from "@/store/settings-notifications";

vi.mock("vue-sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

const behind = (id: string, count: number) => ({
  id,
  name: id,
  branch: "main",
  behind: count,
});

describe("behind notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates from authoritative status and clears itself when the repo catches up", () => {
    const notifications = useSettingsNotifications();

    notifications.notifyBehind([behind("Connections", 13)]);
    expect(notifications.notifications.value[0]).toMatchObject({
      title: "Connections",
      body: "13 commits behind its remote",
      read: false,
    });

    notifications.markNotificationsRead();
    notifications.reconcileBehindNotification("Connections", 17);
    expect(notifications.notifications.value[0]).toMatchObject({
      body: "17 commits behind its remote",
      read: true,
      behind: [expect.objectContaining({ id: "Connections", behind: 17 })],
    });

    notifications.reconcileBehindNotification("Connections", 0);
    expect(notifications.notifications.value).toEqual([]);
  });

  it("keeps unresolved repos together and removes only the repo that caught up", () => {
    const notifications = useSettingsNotifications();

    notifications.notifyBehind([behind("first", 2)]);
    notifications.notifyBehind([behind("second", 4)]);
    expect(notifications.notifications.value[0]).toMatchObject({
      title: "Repos behind remote",
      body: "2 repos have new remote commits",
      behind: [
        expect.objectContaining({ id: "first", behind: 2 }),
        expect.objectContaining({ id: "second", behind: 4 }),
      ],
    });

    notifications.reconcileBehindNotification("first", 0);
    expect(notifications.notifications.value[0]).toMatchObject({
      title: "second",
      body: "4 commits behind its remote",
      behind: [expect.objectContaining({ id: "second", behind: 4 })],
    });
  });
});
