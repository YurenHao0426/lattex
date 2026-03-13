// Copyright (c) 2026 Yuren Hao
// Licensed under AGPL-3.0 - see LICENSE file

import { create } from 'zustand'

interface ModalState {
  // Input modal
  inputOpen: boolean
  inputTitle: string
  inputPlaceholder: string
  inputDefault: string
  inputResolve: ((value: string | null) => void) | null

  // Confirm modal
  confirmOpen: boolean
  confirmTitle: string
  confirmMessage: string
  confirmDanger: boolean
  confirmResolve: ((ok: boolean) => void) | null

  // Alert modal
  alertOpen: boolean
  alertTitle: string
  alertMessage: string
  alertResolve: (() => void) | null
}

export const useModalStore = create<ModalState>(() => ({
  inputOpen: false,
  inputTitle: '',
  inputPlaceholder: '',
  inputDefault: '',
  inputResolve: null,

  confirmOpen: false,
  confirmTitle: '',
  confirmMessage: '',
  confirmDanger: false,
  confirmResolve: null,

  alertOpen: false,
  alertTitle: '',
  alertMessage: '',
  alertResolve: null,
}))

export function showInput(title: string, placeholder = '', defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    useModalStore.setState({
      inputOpen: true,
      inputTitle: title,
      inputPlaceholder: placeholder,
      inputDefault: defaultValue,
      inputResolve: resolve,
    })
  })
}

export function showConfirm(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    useModalStore.setState({
      confirmOpen: true,
      confirmTitle: title,
      confirmMessage: message,
      confirmDanger: danger,
      confirmResolve: resolve,
    })
  })
}

export function showAlert(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    useModalStore.setState({
      alertOpen: true,
      alertTitle: title,
      alertMessage: message,
      alertResolve: resolve,
    })
  })
}
