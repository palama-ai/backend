const express = require('express');
const router = express.Router();
const { sql } = require('../db');

// Base URL for the site
const BASE_URL = process.env.FRONTEND_URL || 'https://glowimatch.vercel.app';

// Static pages with their priorities and change frequencies
const STATIC_PAGES = [
    { path: '/', priority: 1.0, changefreq: 'weekly' },
    { path: '/about', priority: 0.8, changefreq: 'monthly' },
    { path: '/contact', priority: 0.7, changefreq: 'monthly' },
    { path: '/blog', priority: 0.9, changefreq: 'daily' },
    { path: '/interactive-skin-quiz', priority: 0.9, changefreq: 'weekly' },
    { path: '/terms', priority: 0.3, changefreq: 'yearly' },
];

// Generate XML for a single URL entry
function generateUrlEntry(loc, lastmod, changefreq, priority) {
    return `
  <url>
    <loc>${loc}</loc>
    ${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}

// GET /api/sitemap.xml - Generate dynamic sitemap
router.get('/sitemap.xml', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];

        // Start building the sitemap
        let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

        // Add static pages
        for (const page of STATIC_PAGES) {
            sitemap += generateUrlEntry(
                `${BASE_URL}${page.path}`,
                today,
                page.changefreq,
                page.priority
            );
        }

        // Fetch all published blogs from database
        try {
            const blogs = await sql`
        SELECT slug, updated_at, created_at 
        FROM blogs 
        WHERE published = 1 OR published = true
        ORDER BY created_at DESC
      `;

            // Add blog posts to sitemap
            for (const blog of blogs) {
                const lastmod = blog.updated_at || blog.created_at;
                const formattedDate = lastmod
                    ? new Date(lastmod).toISOString().split('T')[0]
                    : today;

                sitemap += generateUrlEntry(
                    `${BASE_URL}/blog/${blog.slug}`,
                    formattedDate,
                    'weekly',
                    0.7
                );
            }

            console.log(`[sitemap] Generated sitemap with ${STATIC_PAGES.length} static pages and ${blogs.length} blog posts`);
        } catch (dbErr) {
            console.error('[sitemap] Error fetching blogs:', dbErr);
            // Continue without blog posts if database error
        }

        // Close the sitemap
        sitemap += '\n</urlset>';

        // Set proper content type for XML
        res.set('Content-Type', 'application/xml');
        res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
        res.send(sitemap);

    } catch (err) {
        console.error('[sitemap] Error generating sitemap:', err);
        res.status(500).json({ error: 'Failed to generate sitemap' });
    }
});

// GET /api/sitemap/stats - Get sitemap statistics
router.get('/stats', async (req, res) => {
    try {
        const blogs = await sql`
      SELECT COUNT(*) as count FROM blogs WHERE published = 1 OR published = true
    `;

        res.json({
            success: true,
            data: {
                staticPages: STATIC_PAGES.length,
                blogPosts: blogs[0]?.count || 0,
                totalUrls: STATIC_PAGES.length + (blogs[0]?.count || 0),
                sitemapUrl: `${BASE_URL}/sitemap.xml`
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to get sitemap stats' });
    }
});

module.exports = router;
