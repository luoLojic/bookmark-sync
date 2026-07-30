/**
 * scheduler/alarms.ts —— 定时同步（FR-7）与启动同步（FR-8）。
 *
 * 两个开关默认关闭（需求第 10 节）。用 chrome.alarms 而不是 setInterval：
 * MV3 的 worker 会被终止，setInterval 随之消失，而 alarm 会把 worker 唤醒。
 *
 * 与手动同步竞争时由单实例锁拒绝（NFR-10）—— 这里不做额外判断，
 * 让锁成为唯一的仲裁者，避免两处逻辑各自判断出现分歧。
 */

export const SYNC_ALARM = 'bookmark-sync-periodic';

export interface AlarmsApi {
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void;
  clear(name: string): Promise<boolean>;
  getAll(): Promise<{ name: string; periodInMinutes?: number }[]>;
}

export const chromeAlarms: AlarmsApi = {
  create: (name, info) => chrome.alarms.create(name, info),
  clear: (name) => chrome.alarms.clear(name),
  getAll: () => chrome.alarms.getAll() as Promise<{ name: string; periodInMinutes?: number }[]>,
};

/** chrome.alarms 的最小周期是 1 分钟，低于此值会被静默改写。 */
const MIN_PERIOD_MINUTES = 1;

/**
 * 按配置装好或撤掉定时同步。配置变更后调用一次即可（幂等）。
 *
 * delayInMinutes 与 periodInMinutes 取同值：不这样写的话，Chrome 会
 * 立刻触发第一次，用户刚保存设置就被同步打断。
 */
export async function applySchedule(
  config: { scheduleEnabled: boolean; scheduleMinutes: number },
  api: AlarmsApi,
): Promise<void> {
  await api.clear(SYNC_ALARM);
  if (!config.scheduleEnabled) return;

  const minutes = Math.max(MIN_PERIOD_MINUTES, Math.round(config.scheduleMinutes));
  api.create(SYNC_ALARM, { periodInMinutes: minutes, delayInMinutes: minutes });
}

export async function isScheduled(api: AlarmsApi): Promise<boolean> {
  return (await api.getAll()).some((a) => a.name === SYNC_ALARM);
}
