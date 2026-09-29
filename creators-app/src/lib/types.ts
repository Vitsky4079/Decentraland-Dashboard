import type { MediaKind } from "./media-types";

export type MediaFile = {
  id: string;
  user_id: string;
  storage_key: string;
  original_name: string;
  mime_type: string;
  kind: MediaKind;
  size_bytes: number;
  url: string;
  created_at: string;
};
