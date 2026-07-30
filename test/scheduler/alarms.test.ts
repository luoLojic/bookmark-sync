import { describe, expect, it } from 'vitest';
import { SYNC_ALARM, applySchedule, isScheduled, type AlarmsApi } from '../../src/scheduler/alarms.js';

function fakeAlarms() {
  const alarms = new Map<string, { periodInMinutes?: number; delayInMinutes?: number }>();
  const api: AlarmsApi = {
    create(name, info) {
      alarms.set(name, info);
    },
    async clear(name) {
      return alarms.delete(name);
    },
    async getAll() {
      return [...alarms.entries()].map(([name, info]) => ({
        name,
        ...(info.periodInMinutes === undefined ? {} : { periodInMinutes: info.periodInMinutes }),
      }));
    },
  };
  return { api, alarms };
}

describe('applySchedule（FR-7 定时同步）', () => {
  it('开关关闭时不装 alarm（需求第 10 节：默认关闭）', async () => {
    const { api, alarms } = fakeAlarms();
    await applySchedule({ scheduleEnabled: false, scheduleMinutes: 30 }, api);
    expect(alarms.size).toBe(0);
    expect(await isScheduled(api)).toBe(false);
  });

  it('开关打开时按间隔装 alarm', async () => {
    const { api, alarms } = fakeAlarms();
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 30 }, api);
    expect(alarms.get(SYNC_ALARM)?.periodInMinutes).toBe(30);
    expect(await isScheduled(api)).toBe(true);
  });

  it('首次触发也延后一个间隔 —— 否则用户刚保存设置就被同步打断', async () => {
    const { api, alarms } = fakeAlarms();
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 15 }, api);
    expect(alarms.get(SYNC_ALARM)?.delayInMinutes).toBe(15);
  });

  it('间隔低于 1 分钟时钳到 1（chrome.alarms 的下限）', async () => {
    const { api, alarms } = fakeAlarms();
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 0 }, api);
    expect(alarms.get(SYNC_ALARM)?.periodInMinutes).toBe(1);
  });

  it('小数间隔取整', async () => {
    const { api, alarms } = fakeAlarms();
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 30.6 }, api);
    expect(alarms.get(SYNC_ALARM)?.periodInMinutes).toBe(31);
  });

  it('幂等：重复调用不会装出两个 alarm', async () => {
    const { api, alarms } = fakeAlarms();
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 30 }, api);
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 30 }, api);
    expect(alarms.size).toBe(1);
  });

  it('从开到关会撤掉已装的 alarm', async () => {
    const { api, alarms } = fakeAlarms();
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 30 }, api);
    await applySchedule({ scheduleEnabled: false, scheduleMinutes: 30 }, api);
    expect(alarms.size).toBe(0);
  });

  it('改间隔时用新值替换旧 alarm', async () => {
    const { api, alarms } = fakeAlarms();
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 30 }, api);
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 60 }, api);
    expect(alarms.size).toBe(1);
    expect(alarms.get(SYNC_ALARM)?.periodInMinutes).toBe(60);
  });

  it('不碰其他 alarm', async () => {
    const { api, alarms } = fakeAlarms();
    api.create('别的功能', { periodInMinutes: 5 });
    await applySchedule({ scheduleEnabled: true, scheduleMinutes: 30 }, api);
    await applySchedule({ scheduleEnabled: false, scheduleMinutes: 30 }, api);
    expect(alarms.has('别的功能')).toBe(true);
  });
});
