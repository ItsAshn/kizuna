import { useState, useRef, useEffect, useCallback } from 'react'
import { Play, Pause } from 'lucide-react'
import './VoiceMessagePlayer.css'

interface Props {
  url: string
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default function VoiceMessagePlayer({ url }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [waveform, setWaveform] = useState<number[]>([])

  useEffect(() => {
    const audio = new Audio()
    audioRef.current = audio
    audio.preload = 'auto'
    audio.src = url

    audio.addEventListener('loadedmetadata', () => {
      setDuration(audio.duration)
      setLoaded(true)
    })

    audio.addEventListener('timeupdate', () => {
      setCurrentTime(audio.currentTime)
    })

    audio.addEventListener('ended', () => {
      setPlaying(false)
      setCurrentTime(0)
    })

    audio.addEventListener('play', () => setPlaying(true))
    audio.addEventListener('pause', () => setPlaying(false))

    return () => {
      audio.pause()
      audio.src = ''
    }
  }, [url])

  useEffect(() => {
    if (!loaded) return
    fetch(url)
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        const ctx = new AudioContext()
        return ctx.decodeAudioData(buffer)
      })
      .then((audioBuffer) => {
        const data = audioBuffer.getChannelData(0)
        const samples = 80
        const blockSize = Math.floor(data.length / samples)
        const wf: number[] = []
        for (let i = 0; i < samples; i++) {
          let sum = 0
          for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(data[i * blockSize + j])
          }
          wf.push(sum / blockSize)
        }
        const max = Math.max(...wf)
        setWaveform(max > 0 ? wf.map((v) => v / max) : wf)
      })
      .catch(() => {
        setWaveform(Array.from({ length: 80 }, () => Math.random() * 0.5 + 0.25))
      })
  }, [url, loaded])

  useEffect(() => {
    if (!canvasRef.current || waveform.length === 0) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = canvas.offsetWidth * devicePixelRatio
    canvas.height = canvas.offsetHeight * devicePixelRatio
    ctx.scale(devicePixelRatio, devicePixelRatio)

    const w = canvas.offsetWidth
    const h = canvas.offsetHeight
    const barW = (w / waveform.length) * 0.6
    const gap = (w / waveform.length) * 0.4

    ctx.clearRect(0, 0, w, h)

    const progress = duration > 0 ? currentTime / duration : 0

    waveform.forEach((v, i) => {
      const x = i * (barW + gap)
      const barH = Math.max(2, v * h * 0.8)
      const y = (h - barH) / 2
      const isPlayed = (i / waveform.length) <= progress

      ctx.fillStyle = isPlayed ? 'var(--brand)' : 'var(--text-muted)'
      ctx.beginPath()
      ctx.roundRect(x, y, barW, barH, 2)
      ctx.fill()
    })
  }, [waveform, currentTime, duration])

  const togglePlay = useCallback(() => {
    if (!audioRef.current) return
    if (playing) {
      audioRef.current.pause()
    } else {
      audioRef.current.currentTime = currentTime >= duration - 0.1 ? 0 : currentTime
      audioRef.current.play()
    }
  }, [playing, currentTime, duration])

  return (
    <div className="voice-player">
      <button className="voice-player__btn" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause className="icon-sm" /> : <Play className="icon-sm" />}
      </button>
      <canvas ref={canvasRef} className="voice-player__waveform" />
      <span className="voice-player__time">
        {loaded ? formatDuration(playing ? currentTime : duration) : '--:--'}
      </span>
    </div>
  )
}
