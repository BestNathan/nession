export interface QuickCommandItem {
  id: string;
  label: string;
  command: string;
  raw?: boolean;
  sort_order?: number;
  created_at?: number;
}

export interface CommandsListResponse {
  commands: QuickCommandItem[];
}

export interface CommandsAddResponse {
  success: boolean;
  id?: string;
  error?: string;
}

export interface CommandsRemoveResponse {
  success: boolean;
  error?: string;
}

export interface CommandsUpdateResponse {
  success: boolean;
  error?: string;
}
