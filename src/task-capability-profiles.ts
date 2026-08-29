export type TaskCapabilityProfileName =
  | 'full'
  | 'soul-maintenance'
  | 'research'
  | 'read-only';

export interface TaskCapabilityProfile {
  name: TaskCapabilityProfileName;
  version: number;
  projectAccess: 'none' | 'read-only' | 'read-write';
  groupAccess: 'read-only' | 'read-write';
  additionalMountAccess: 'none' | 'read-only' | 'configured';
  persistentSessionAccess: boolean;
  skillAccess: boolean;
}

export const TASK_CAPABILITY_PROFILES: Record<
  TaskCapabilityProfileName,
  TaskCapabilityProfile
> = {
  full: {
    name: 'full', version: 1, projectAccess: 'read-write',
    groupAccess: 'read-write', additionalMountAccess: 'configured',
    persistentSessionAccess: true,
    skillAccess: true,
  },
  'soul-maintenance': {
    name: 'soul-maintenance', version: 1, projectAccess: 'read-write',
    groupAccess: 'read-write', additionalMountAccess: 'configured',
    persistentSessionAccess: true,
    skillAccess: true,
  },
  research: {
    name: 'research', version: 1, projectAccess: 'none',
    groupAccess: 'read-write', additionalMountAccess: 'read-only',
    persistentSessionAccess: true,
    skillAccess: true,
  },
  'read-only': {
    name: 'read-only', version: 1, projectAccess: 'read-only',
    groupAccess: 'read-only', additionalMountAccess: 'read-only',
    persistentSessionAccess: false,
    skillAccess: false,
  },
};

export function resolveTaskCapabilityProfile(
  name: string,
): TaskCapabilityProfile {
  const profile = TASK_CAPABILITY_PROFILES[name as TaskCapabilityProfileName];
  if (!profile) throw new Error(`Unknown task capability profile: ${name}`);
  return profile;
}
