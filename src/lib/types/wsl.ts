// Mirrors src-tauri/src/core/wsl.rs (serde camelCase). Change both or neither.

export interface WslDistro {
  /** `Ubuntu`, `docker-desktop`… — the registry's DistributionName */
  name: string;
  isDefault: boolean;
  /** the distro's default login uid; its home is the entry point */
  uid: number;
}
