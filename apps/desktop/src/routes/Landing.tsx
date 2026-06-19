import { useState } from 'react'
import { FaWindows, FaLinux, FaApple, FaGithub, FaDocker } from 'react-icons/fa'
import { MessageCircle, Mic, Monitor, Lock, Code, Download, ExternalLink, ArrowRight, Server } from 'lucide-react'
import './Landing.css'

interface LandingProps {
  onConnect: (url: string) => void
  onEnterApp: () => void
}

const LINUX_CMD = 'curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install-desktop.sh | bash'
const MAC_CMD = 'curl -fsSL https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install-desktop.sh | bash'
const WIN_CMD = 'irm https://raw.githubusercontent.com/ItsAshn/kizuna/main/scripts/install-desktop.ps1 | iex'
const DOCKER_COMPOSE = `git clone https://github.com/ItsAshn/kizuna.git
cd kizuna
cp apps/server/.env.example apps/server/.env
# edit apps/server/.env with your settings
docker compose up -d`

const FEATURES = [
  {
    icon: Mic,
    title: 'Voice Channels',
    desc: 'Low-latency voice with individual volume control, mute, and deafen. Powered by mediasoup WebRTC.',
  },
  {
    icon: Monitor,
    title: 'Screen Sharing',
    desc: 'Share your screen or individual windows with crystal-clear quality during voice calls.',
  },
  {
    icon: MessageCircle,
    title: 'Text Chat',
    desc: 'Real-time messaging with threads, replies, and mentions. Full chat history stored on your server.',
  },
  {
    icon: Server,
    title: 'Self-Hosted',
    desc: 'You own the server. Deploy on your own hardware with Docker in minutes. Your data stays yours.',
  },
  {
    icon: Lock,
    title: 'End-to-End Encrypted',
    desc: 'Direct messages are encrypted with tweetnacl. Only the intended recipients can read them.',
  },
  {
    icon: Code,
    title: 'Open Source',
    desc: 'AGPLv3 licensed. Audit the code, contribute, or fork it. No vendor lock-in, no telemetry.',
  },
]

const STEPS = [
  { step: '1', title: 'Download', desc: 'Get the desktop app for Linux, macOS, or Windows, or jump straight into the web app.' },
  { step: '2', title: 'Connect', desc: 'Try the official test server at server.use-kizuna.com or connect to any self-hosted instance.' },
  { step: '3', title: 'Chat & Voice', desc: 'Send messages, hop into voice channels, and share your screen with your community.' },
]

export default function Landing({ onConnect, onEnterApp }: LandingProps) {
  const [installTab, setInstallTab] = useState<'linux' | 'macos' | 'windows'>('linux')
  const [copied, setCopied] = useState(false)
  const [dockerCopied, setDockerCopied] = useState(false)

  function handleCopy(text: string, setter: (v: boolean) => void) {
    navigator.clipboard.writeText(text)
    setter(true)
    setTimeout(() => setter(false), 2000)
  }

  const installCmd = installTab === 'linux' ? LINUX_CMD : installTab === 'macos' ? MAC_CMD : WIN_CMD

  return (
    <div className="landing">
      <nav className="landing-nav">
        <div className="landing-nav__inner">
          <a href="/" className="landing-nav__brand">
            <img src="/Logo.svg" alt="Kizuna" className="landing-nav__logo" />
            <span className="landing-nav__name">Kizuna</span>
          </a>
          <button className="landing-nav__cta" onClick={onEnterApp}>
            Launch App
            <ArrowRight size={14} />
          </button>
        </div>
      </nav>

      <section className="landing-hero">
        <div className="landing-hero__glow" />
        <img src="/Logo.svg" alt="Kizuna" className="landing-hero__logo" />
        <h1 className="landing-hero__title">
          Self-hosted voice
          <br />
          <span className="landing-hero__title-accent">&amp; chat</span>
        </h1>
        <p className="landing-hero__desc">
          An open-source, privacy-first communication platform.
          Host your own server, own your data, and stay connected with your community.
        </p>
        <div className="landing-hero__actions">
          <a href="#download" className="landing-hero__btn landing-hero__btn--primary">
            <Download size={16} />
            Download
          </a>
          <button className="landing-hero__btn landing-hero__btn--secondary" onClick={() => onConnect('https://server.use-kizuna.com')}>
            Try Official Server
            <ExternalLink size={14} />
          </button>
        </div>
        <p className="landing-hero__hint">
          Also available as a <button className="landing-hero__link" onClick={onEnterApp}>web app</button> — no download needed.
        </p>
      </section>

      <section className="landing-features" id="features">
        <h2 className="landing-section__title">Everything you need</h2>
        <p className="landing-section__subtitle">A complete communication suite you control end-to-end.</p>
        <div className="landing-features__grid">
          {FEATURES.map((f) => (
            <div key={f.title} className="landing-feature-card">
              <div className="landing-feature-card__icon">
                <f.icon size={22} />
              </div>
              <h3 className="landing-feature-card__title">{f.title}</h3>
              <p className="landing-feature-card__desc">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-how" id="how-it-works">
        <h2 className="landing-section__title">How it works</h2>
        <p className="landing-section__subtitle">Three steps to start chatting with your community.</p>
        <div className="landing-how__grid">
          {STEPS.map((s) => (
            <div key={s.step} className="landing-how-card">
              <span className="landing-how-card__step">{s.step}</span>
              <h3 className="landing-how-card__title">{s.title}</h3>
              <p className="landing-how-card__desc">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-download" id="download">
        <h2 className="landing-section__title">Download the desktop app</h2>
        <p className="landing-section__subtitle">Available for Linux, macOS, and Windows.</p>
        <div className="landing-download__card">
          <div className="landing-download__tabs">
            <button
              className={`landing-download__tab ${installTab === 'linux' ? 'landing-download__tab--active' : ''}`}
              onClick={() => setInstallTab('linux')}
            >
              <FaLinux size={13} />
              <span>Linux</span>
            </button>
            <button
              className={`landing-download__tab ${installTab === 'macos' ? 'landing-download__tab--active' : ''}`}
              onClick={() => setInstallTab('macos')}
            >
              <FaApple size={13} />
              <span>macOS</span>
            </button>
            <button
              className={`landing-download__tab ${installTab === 'windows' ? 'landing-download__tab--active' : ''}`}
              onClick={() => setInstallTab('windows')}
            >
              <FaWindows size={13} />
              <span>Windows</span>
            </button>
          </div>
          <div className="landing-download__code">
            <code className="landing-download__cmd">{installCmd}</code>
            <button
              className="landing-download__copy"
              onClick={() => handleCopy(installCmd, setCopied)}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          {installTab === 'macos' && (
            <p className="landing-download__note">
              Apple Silicon only. The build is unsigned — the installer clears the Gatekeeper quarantine flag automatically.
            </p>
          )}
        </div>
        <a
          href="https://github.com/ItsAshn/kizuna/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
          className="landing-download__gh-link"
        >
          <FaGithub size={14} />
          View all releases on GitHub
          <ExternalLink size={12} />
        </a>
      </section>

      <section className="landing-selfhost" id="self-host">
        <h2 className="landing-section__title">Host your own server</h2>
        <p className="landing-section__subtitle">Deploy in minutes with Docker Compose. You control everything.</p>
        <div className="landing-selfhost__card">
          <div className="landing-selfhost__code">
            <div className="landing-selfhost__code-header">
              <FaDocker size={14} />
              <span>docker compose</span>
            </div>
            <pre className="landing-selfhost__pre"><code>{DOCKER_COMPOSE}</code></pre>
            <button
              className="landing-selfhost__copy"
              onClick={() => handleCopy(DOCKER_COMPOSE, setDockerCopied)}
            >
              {dockerCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
        <div className="landing-selfhost__more">
          <a href="https://github.com/ItsAshn/kizuna" target="_blank" rel="noopener noreferrer" className="landing-selfhost__link">
            <FaGithub size={14} />
            Full documentation on GitHub
            <ExternalLink size={12} />
          </a>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer__inner">
          <div className="landing-footer__brand">
            <img src="/Logo.svg" alt="Kizuna" className="landing-footer__logo" />
            <span>Kizuna</span>
          </div>
          <div className="landing-footer__links">
            <a href="https://github.com/ItsAshn/kizuna" target="_blank" rel="noopener noreferrer">
              <FaGithub size={18} />
            </a>
          </div>
        </div>
        <p className="landing-footer__copy">
          Open source under <a href="https://github.com/ItsAshn/kizuna/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">AGPLv3 License</a>
        </p>
      </footer>

      {import.meta.env.DEV && (
        <button className="landing-dev-toggle" onClick={onEnterApp}>
          Back to Dashboard
        </button>
      )}
    </div>
  )
}
