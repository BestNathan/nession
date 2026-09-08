import { createContext } from 'react';
import type { CapsuleExperience } from '@/features/terminal/capsule/types';
import type { CapsuleExperienceConfig } from '@/features/terminal/capsule/config/experience';
import type { CapsuleStateValue } from '@/features/terminal/capsule/state/useCapsuleState';

export interface CapsuleContextValue extends CapsuleStateValue {
  experience: CapsuleExperience;
  experienceConfig: CapsuleExperienceConfig;
  sendText: (text: string) => void;
}

export const CapsuleContext = createContext<CapsuleContextValue | null>(null);
