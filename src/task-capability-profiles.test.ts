import { describe, expect, it } from 'vitest';
import {
  resolveTaskCapabilityProfile,
  TASK_CAPABILITY_PROFILES,
} from './task-capability-profiles.js';

describe('task capability profiles', () => {
  it('defines the closed version-one profile set', () => {
    expect(Object.keys(TASK_CAPABILITY_PROFILES).sort()).toEqual([
      'full', 'read-only', 'research', 'soul-maintenance',
    ]);
    expect(Object.values(TASK_CAPABILITY_PROFILES).every((p) => p.version === 1)).toBe(true);
  });

  it('keeps read-only business mounts read-only and session state ephemeral', () => {
    const profile = resolveTaskCapabilityProfile('read-only');
    expect(profile.projectAccess).toBe('read-only');
    expect(profile.groupAccess).toBe('read-only');
    expect(profile.additionalMountAccess).toBe('read-only');
    expect(profile.persistentSessionAccess).toBe(false);
  });

  it('rejects unknown persisted profiles', () => {
    expect(() => resolveTaskCapabilityProfile('custom')).toThrow(
      'Unknown task capability profile',
    );
  });
});
