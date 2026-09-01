import { createContext } from 'react';
import type { CapsuleExperience } from '@/session-first/capsule/types';
import type { CapsuleExperienceConfig } from '@/session-first/capsule/config/experience';
import type { CapsuleStateValue } from '@/session-first/capsule/state/useCapsuleState';

export interface CapsuleContextValue extends CapsuleStateValue {
  experience: CapsuleExperience;
  experienceConfig: CapsuleExperienceConfig;
  sendText: (text: string) => void;
}

export const CapsuleContext = createContext<CapsuleContextValue | null>(null);
