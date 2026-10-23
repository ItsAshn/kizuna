import { useState, useEffect, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import type { VirtuosoHandle } from 'react-virtuoso'
import { uploadAttachment } from '@kizuna/shared'
import type { Message } from '@kizuna/shared'
import { useChatStore } from '../store/chatStore'
import { useNotificationStore } from '../store/notificationStore'
import { showErrorToast } from '../utils/showNotification'
import type { ServerSession } from '../store/serverStore'

/** A conversation a message is addressed to, bound when the action starts. */
export interface ConversationTarget {
  id: string
  type: 'channel' | 'dm' | 'group-dm'
}

interface UseAttachmentUploadOptions {
  session: ServerSession | null
  atBottom: boolean
  input: string
  setInput: (value: string) => void
  setSendError: (err: string | null) => void
  activeConversation: ConversationTarget | null
  sendToConversation: (
    target: ConversationTarget,
    plain: string,
    attIds?: string[],
    replyToId?: string,
  ) => Promise<Message | null>
  addMessage: (channelId: string, message: Message) => void
  virtuosoRef: MutableRefObject<VirtuosoHandle | null>
  lastCountAtBottom: MutableRefObject<number>
  inputRef: MutableRefObject<HTMLTextAreaElement | null>
}

// Owns the pending-attachment lifecycle: file picking, drag & drop, paste,
// upload progress/cancel, and voice-recording uploads.
export function useAttachmentUpload({
  session,
  atBottom,
  input,
  setInput,
  setSendError,
  activeConversation,
  sendToConversation,
  addMessage,
  virtuosoRef,
  lastCountAtBottom,
  inputRef,
}: UseAttachmentUploadOptions) {
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null)
  const [pendingAttachmentId, setPendingAttachmentId] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    return () => {
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
    }
  }, [pendingPreviewUrl])

  const setPendingFileFromList = useCallback(
    (files: File[]) => {
      if (files.length === 0) return
      const [file, ...rest] = files
      setPendingFile(file)
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
      const isImage = file.type.startsWith('image/')
      setPendingPreviewUrl(isImage ? URL.createObjectURL(file) : null)
      if (rest.length > 0) {
        useNotificationStore.getState().addNotification({
          type: 'announce',
          title: 'One file at a time',
          body: `Only "${file.name}" was attached. Send it, then attach the other ${rest.length} file${rest.length === 1 ? '' : 's'} separately.`,
        })
      }
    },
    [pendingPreviewUrl],
  )

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    setPendingFileFromList(files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const cancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort()
  }, [])

  const clearPendingFile = () => {
    if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
    setPendingFile(null)
    setPendingPreviewUrl(null)
    setPendingAttachmentId(null)
  }

  /** Uploads the pending file and sends it. Resolves true once the message
   * was sent, so the caller can clear UI tied to it (the reply bar). */
  const handleUpload = async (replyToId?: string): Promise<boolean> => {
    if (!pendingFile || !session) return false

    const target = activeConversation
    if (!target) return false
    const targetChannelId = target.id
    let sent = false

    setUploading(true)
    setUploadProgress(0)
    const abortController = new AbortController()
    uploadAbortRef.current = abortController

    const wasAtBottom = atBottom

    try {
      const result = await uploadAttachment(
        session.url,
        targetChannelId,
        pendingFile,
        (pct) => setUploadProgress(pct),
        abortController.signal,
      )
      setPendingAttachmentId(result.id)
      const attachmentText = `![${result.filename}](${result.url})`
      const text = input.trim()
      const finalText = text ? text + '\n' + attachmentText : attachmentText

      const message = await sendToConversation(target, finalText, [result.id], replyToId)
      if (!message) {
        setUploading(false)
        return false
      }
      sent = true
      addMessage(message.channel_id || targetChannelId, message)
      setInput('')
      if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
      setPendingFile(null)
      setPendingPreviewUrl(null)
      setPendingAttachmentId(null)
      setSendError(null)
      if (inputRef.current) {
        inputRef.current.style.height = 'auto'
        inputRef.current.focus()
      }
      if (!wasAtBottom) {
        requestAnimationFrame(() => {
          const msgs = useChatStore.getState().messages[targetChannelId] || []
          if (msgs.length > 0) {
            virtuosoRef.current?.scrollToIndex(msgs.length - 1)
          }
          lastCountAtBottom.current = msgs.length
        })
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User-initiated cancel — clear the pending file instead of showing an error.
        if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
        setPendingFile(null)
        setPendingPreviewUrl(null)
        setPendingAttachmentId(null)
      } else {
        const e = err as { response?: { data?: { error?: string } }; message?: string }
        setSendError(e?.response?.data?.error || e?.message || 'Failed to upload file')
        if (pendingPreviewUrl) URL.revokeObjectURL(pendingPreviewUrl)
        setPendingPreviewUrl(null)
        setPendingAttachmentId(null)
      }
    }
    uploadAbortRef.current = null
    setUploading(false)
    return sent
  }

  /** `target` is the conversation the recording was started in, bound by the
   * caller at record start. */
  const handleVoiceRecordingComplete = useCallback(
    async (file: File, target: ConversationTarget) => {
      const targetChannelId = target.id
      if (!session) return
      setPendingFile(file)
      setUploading(true)
      setUploadProgress(0)
      const abortController = new AbortController()
      uploadAbortRef.current = abortController
      try {
        const result = await uploadAttachment(
          session.url,
          targetChannelId,
          file,
          (pct) => setUploadProgress(pct),
          abortController.signal,
        )
        // Read the composer at stop time, not at record-start time — but only
        // if it still belongs to the recording's conversation.
        const st = useChatStore.getState()
        const stillHere =
          (st.activeChannelId || st.activeDMChannelId || st.activeGroupDMChannelId) ===
          targetChannelId
        const msgText = stillHere ? (inputRef.current?.value ?? '').trim() : ''
        const attachmentText = msgText
          ? `${msgText}\n![voice-message.webm](${result.url})`
          : `![voice-message.webm](${result.url})`

        const message = await sendToConversation(target, attachmentText, [result.id])
        if (message) {
          addMessage(targetChannelId, message)
          if (stillHere && msgText) setInput('')
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('Failed to send voice message:', err)
          showErrorToast('send the voice message')
        }
      }
      uploadAbortRef.current = null
      setUploading(false)
      setPendingFile(null)
    },
    [session, sendToConversation, addMessage, inputRef, setInput],
  )

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) {
      setIsDragOver(false)
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const imageFiles = Array.from(e.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith('image/'),
    )
    if (imageFiles.length > 0) {
      e.preventDefault()
      setPendingFileFromList(imageFiles)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    setPendingFileFromList(Array.from(e.dataTransfer.files))
  }

  return {
    uploading,
    uploadProgress,
    pendingFile,
    pendingPreviewUrl,
    pendingAttachmentId,
    setPendingAttachmentId,
    isDragOver,
    fileInputRef,
    setPendingFileFromList,
    handleFileSelect,
    cancelUpload,
    clearPendingFile,
    handleUpload,
    handleVoiceRecordingComplete,
    handleDragOver,
    handleDragLeave,
    handlePaste,
    handleDrop,
  }
}
