import { useCallback, useEffect, useRef, useState } from 'react'
import { useVoiceStore } from '../store/voiceStore'

/**
 * Records audio from the microphone and delivers the finished recording as a
 * File via `onComplete`. Canceling (stopRecording(false)) or unmounting
 * discards the recording without invoking the callback.
 */
export function useVoiceRecorder(onComplete: (file: File) => void) {
  const [recording, setRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const startRecording = useCallback(async () => {
    try {
      const audioInputDeviceId = useVoiceStore.getState().audioInputDeviceId
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(audioInputDeviceId ? { deviceId: { ideal: audioInputDeviceId } } : {}),
          // Echo cancellation routes the capture through the OS communications
          // path, which pauses/ducks other apps' audio. A recording has no
          // playout to cancel, so keep it off (noise suppression and auto gain
          // stay at browser defaults).
          echoCancellation: false,
        },
      })
      const mr = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      })
      mediaRecorderRef.current = mr
      chunksRef.current = []

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }

      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: mr.mimeType })
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: mr.mimeType })
        onCompleteRef.current(file)
      }

      mr.start()
      setRecording(true)
      setRecordingTime(0)
      timerRef.current = setInterval(() => {
        setRecordingTime((t) => t + 1)
      }, 1000)
    } catch (err) {
      console.error('Failed to start recording:', err)
    }
  }, [])

  const discard = (mr: MediaRecorder) => {
    // Ending the tracks still fires `stop` on the recorder — detach the
    // handlers first, or a cancel would still deliver an empty recording.
    mr.onstop = null
    mr.ondataavailable = null
    mr.stream.getTracks().forEach((t) => t.stop())
  }

  const stopRecording = useCallback((send: boolean) => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    const mr = mediaRecorderRef.current
    if (mr && mr.state !== 'inactive') {
      if (send) mr.stop()
      else discard(mr)
    }
    setRecording(false)
    setRecordingTime(0)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      const mr = mediaRecorderRef.current
      if (mr && mr.state !== 'inactive') discard(mr)
    }
  }, [])

  return { recording, recordingTime, startRecording, stopRecording }
}
