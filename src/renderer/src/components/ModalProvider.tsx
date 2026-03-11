import { useState, useEffect, useRef } from 'react'
import { useModalStore } from '../hooks/useModal'

export default function ModalProvider() {
  return (
    <>
      <InputModal />
      <ConfirmModal />
      <AlertModal />
    </>
  )
}

function InputModal() {
  const { inputOpen, inputTitle, inputPlaceholder, inputDefault, inputResolve } = useModalStore()
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputOpen) {
      setValue(inputDefault)
      setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 50)
    }
  }, [inputOpen, inputDefault])

  if (!inputOpen) return null

  const close = (result: string | null) => {
    useModalStore.setState({ inputOpen: false })
    inputResolve?.(result)
  }

  return (
    <div className="modal-overlay" onClick={() => close(null)}>
      <form
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (value.trim()) close(value.trim()) }}
      >
        <div className="modal-title">{inputTitle}</div>
        <input
          ref={inputRef}
          className="modal-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={inputPlaceholder}
          onKeyDown={(e) => { if (e.key === 'Escape') close(null) }}
        />
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={() => close(null)}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>OK</button>
        </div>
      </form>
    </div>
  )
}

function ConfirmModal() {
  const { confirmOpen, confirmTitle, confirmMessage, confirmDanger, confirmResolve } = useModalStore()
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (confirmOpen) setTimeout(() => btnRef.current?.focus(), 50)
  }, [confirmOpen])

  if (!confirmOpen) return null

  const close = (result: boolean) => {
    useModalStore.setState({ confirmOpen: false })
    confirmResolve?.(result)
  }

  return (
    <div className="modal-overlay" onClick={() => close(false)}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{confirmTitle}</div>
        <div className="modal-message">{confirmMessage}</div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={() => close(false)}>Cancel</button>
          <button
            ref={btnRef}
            className={`btn ${confirmDanger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => close(true)}
          >
            {confirmDanger ? 'Delete' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

function AlertModal() {
  const { alertOpen, alertTitle, alertMessage, alertResolve } = useModalStore()
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (alertOpen) setTimeout(() => btnRef.current?.focus(), 50)
  }, [alertOpen])

  if (!alertOpen) return null

  const close = () => {
    useModalStore.setState({ alertOpen: false })
    alertResolve?.()
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{alertTitle}</div>
        <div className="modal-message modal-message-mono">{alertMessage}</div>
        <div className="modal-actions">
          <button ref={btnRef} className="btn btn-primary" onClick={close}>OK</button>
        </div>
      </div>
    </div>
  )
}
