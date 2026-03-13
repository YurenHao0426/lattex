// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import type { ElectronAPI } from './index'

declare global {
  interface Window {
    api: ElectronAPI
  }
}
