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
    <div className={`tabs--${variant}`}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`tabs__tab${tab.key === activeKey ? ' tabs__tab--active' : ''}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
