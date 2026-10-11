type UpdateBannerStatus = "available" | "downloading" | "ready" | "failed";

export type DesktopUpdateControl = {
  status: UpdateBannerStatus | null;
  version: string | null;
  progress: number | null;
  errorMessage: string | null;
  downloadStarting: boolean;
  installing: boolean;
  downloadUpdate: () => void;
  installUpdate: () => void;
};

const DISABLED_UPDATE_CONTROL: DesktopUpdateControl = {
  status: null,
  version: null,
  progress: null,
  errorMessage: null,
  downloadStarting: false,
  installing: false,
  downloadUpdate: () => {},
  installUpdate: () => {},
};

// Preserve the sidebar interface without starting checks, listeners or downloads.
export function useDesktopUpdateControl(): DesktopUpdateControl {
  return DISABLED_UPDATE_CONTROL;
}
