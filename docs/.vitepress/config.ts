import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Kizuna',
  description: 'Self-hosted Discord alternative with text chat, voice channels, and screen sharing.',
  base: '/kizuna/',
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'GitHub', link: 'https://github.com/ItsAshn/kizuna' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Self-Hosting', link: '/guide/deploy' },
            { text: 'Configuration', link: '/guide/configuration' },
            { text: 'Updating', link: '/guide/updating' },
            { text: 'Development', link: '/guide/development' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'System Requirements', link: '/reference/requirements' },
            { text: 'Security', link: '/reference/security' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/ItsAshn/kizuna' },
    ],
  },
})
