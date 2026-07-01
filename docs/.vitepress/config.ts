import { defineConfig } from 'vitepress'

const SITE_URL = 'https://use-kizuna.com'
const OG_IMAGE = `${SITE_URL}/Logo.webp`

export default defineConfig({
  title: 'Kizuna',
  description: 'Self-hosted Discord alternative with text chat, voice channels, and screen sharing. You host the server, you own the data.',
  base: '/kizuna/',
  lang: 'en-US',
  lastUpdated: true,
  cleanUrls: true,
  sitemap: {
    hostname: SITE_URL,
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/Logo.svg' }],
    ['link', { rel: 'icon', type: 'image/webp', sizes: '128x128', href: '/Logo.webp' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Kizuna' }],
    ['meta', { property: 'og:locale', content: 'en_US' }],
    ['meta', { property: 'og:image', content: OG_IMAGE }],
    ['meta', { property: 'og:image:width', content: '1024' }],
    ['meta', { property: 'og:image:height', content: '1024' }],
    ['meta', { property: 'og:image:type', content: 'image/webp' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: OG_IMAGE }],
  ],
  transformHead: (ctx) => {
    const title = ctx.pageData.title ? `${ctx.pageData.title} | Kizuna Docs` : 'Kizuna Docs'
    const description = ctx.pageData.description
      || ctx.pageData.frontmatter.description
      || 'Self-hosted Discord alternative with text chat, voice channels, and screen sharing.'
    return [
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:url', content: `${SITE_URL}${ctx.pageData.relativePath ? `/${ctx.pageData.relativePath.replace(/\.md$/, '').replace(/index$/, '')}` : ''}` }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['link', { rel: 'canonical', href: `${SITE_URL}/kizuna/${ctx.pageData.relativePath?.replace(/\.md$/, '').replace(/index$/, '').replace(/\/$/, '') || ''}` }],
    ]
  },
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
