// Mirrors src-tauri/src/core/preview.rs (serde camelCase). Change both or neither.

export interface TextHead {
  text: string;
  /** the file is longer than what was read */
  truncated: boolean;
  /** a NUL byte in the first 8 KB; `text` is empty then */
  binary: boolean;
}

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'none';
