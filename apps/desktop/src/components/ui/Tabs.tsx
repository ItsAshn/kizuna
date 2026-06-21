import './Tabs.css'

interface Tab {
  key: string
  label: string
}

interface TabsProps {
  tabs: Tab[]
  activeKey: string
  onChange: (key: string) => void
  variant?: 'underline' | 'pill'
}

export default function Tabs({ tabs, activeKey, onChange, variant = 'underline' }: TabsProps) {
  return (
    <div className={`tabs--${variant}`} role="tablist" aria-label="Tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={tab.key === activeKey}
          onClick={() => onChange(tab.key)}
          className={`tabs__tab${tab.key === activeKey ? ' tabs__tab--active' : ''}`}
          tabIndex={tab.key === activeKey ? 0 : -1}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
