const express = require('express');
const cors = require('cors');
const multer = require('multer');
const FormData = require('form-data');
const fetch = require('node-fetch');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json());

// Serve static files from public directory
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Transcription endpoint
app.post('/api/transcribe', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'text');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ 
        error: errorData.error?.message || 'Transcription failed' 
      });
    }

    const transcription = await response.text();
    res.json({ transcription });

  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Claude API proxy endpoint
app.post('/api/claude', async (req, res) => {
  try {
    const { prompt, systemPrompt } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({
        error: errorData.error?.message || 'Claude API failed'
      });
    }

    const data = await response.json();
    res.json(data);

  } catch (error) {
    console.error('Claude API error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WordPress Proxy Endpoints
// ============================================

// Helper function to build WordPress auth header
const getWpAuthHeader = (username, appPassword) => {
  const credentials = Buffer.from(`${username}:${appPassword}`).toString('base64');
  return `Basic ${credentials}`;
};

// Search/Create WordPress categories
app.post('/api/wordpress/categories', async (req, res) => {
  try {
    const { siteUrl, username, appPassword, categoryName } = req.body;
    
    if (!siteUrl || !username || !appPassword) {
      return res.status(400).json({ error: 'Missing WordPress credentials' });
    }

    const baseUrl = siteUrl.replace(/\/$/, '');
    const authHeader = getWpAuthHeader(username, appPassword);

    // First, try to find existing category
    const searchResponse = await fetch(
      `${baseUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(categoryName)}`,
      {
        headers: {
          'Authorization': authHeader
        }
      }
    );

    if (searchResponse.ok) {
      const categories = await searchResponse.json();
      const existingCategory = categories.find(
        cat => cat.name.toLowerCase() === categoryName.toLowerCase()
      );
      if (existingCategory) {
        return res.json({ id: existingCategory.id, name: existingCategory.name });
      }
    }

    // Category doesn't exist, create it
    const createResponse = await fetch(
      `${baseUrl}/wp-json/wp/v2/categories`,
      {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: categoryName })
      }
    );

    if (!createResponse.ok) {
      const errorData = await createResponse.json();
      return res.status(createResponse.status).json({ 
        error: errorData.message || 'Failed to create category' 
      });
    }

    const newCategory = await createResponse.json();
    res.json({ id: newCategory.id, name: newCategory.name });

  } catch (error) {
    console.error('WordPress categories error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload media to WordPress
app.post('/api/wordpress/media', async (req, res) => {
  try {
    const { siteUrl, username, appPassword, imageUrl, title } = req.body;
    
    console.log('Media upload request:', { siteUrl, username: username ? '[set]' : '[missing]', imageUrl, title });
    
    if (!siteUrl || !username || !appPassword || !imageUrl) {
      return res.status(400).json({ error: `Missing required fields. imageUrl: ${imageUrl || 'MISSING'}` });
    }
    
    // Validate URL format
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return res.status(400).json({ error: `Invalid image URL format: ${imageUrl}` });
    }

    // Normalize the site URL - remove trailing slash and ensure https
    let baseUrl = siteUrl.replace(/\/$/, '');
    
    const authHeader = getWpAuthHeader(username, appPassword);

    // Fetch the image from the source URL
    console.log('Fetching image from:', imageUrl);
    const imageResponse = await fetch(imageUrl, { redirect: 'follow' });
    if (!imageResponse.ok) {
      return res.status(400).json({ error: `Failed to fetch image from URL: ${imageResponse.status}` });
    }

    const imageBuffer = await imageResponse.buffer();
    console.log('Image fetched, size:', imageBuffer.length);
    
    // Create a safe filename
    const safeTitle = (title || 'featured-image').replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
    const filename = `${safeTitle}-featured.jpg`;

    // Helper function to create FormData with the image
    const createFormData = () => {
      const formData = new FormData();
      formData.append('file', imageBuffer, {
        filename: filename,
        contentType: 'image/jpeg'
      });
      return formData;
    };

    // Try uploading to WordPress
    const wpMediaUrl = `${baseUrl}/wp-json/wp/v2/media`;
    console.log('Uploading to WordPress:', wpMediaUrl);
    
    let formData = createFormData();
    let uploadResponse = await fetch(wpMediaUrl, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        ...formData.getHeaders()
      },
      body: formData,
      redirect: 'manual' // Don't auto-follow redirects
    });

    // Handle redirects manually to preserve auth header
    if (uploadResponse.status === 301 || uploadResponse.status === 302 || uploadResponse.status === 307 || uploadResponse.status === 308) {
      const redirectUrl = uploadResponse.headers.get('location');
      console.log('Redirect detected to:', redirectUrl);
      
      if (redirectUrl) {
        // Create fresh FormData for the redirect request
        formData = createFormData();
        uploadResponse = await fetch(redirectUrl, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            ...formData.getHeaders()
          },
          body: formData
        });
      }
    }

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('Upload failed:', uploadResponse.status, errorText.substring(0, 500));
      
      // Try to parse as JSON, otherwise return the text
      try {
        const errorData = JSON.parse(errorText);
        return res.status(uploadResponse.status).json({ 
          error: errorData.message || 'Failed to upload media' 
        });
      } catch {
        return res.status(uploadResponse.status).json({ 
          error: `Failed to upload media: ${uploadResponse.status}` 
        });
      }
    }

    const mediaItem = await uploadResponse.json();
    console.log('Media uploaded successfully, ID:', mediaItem.id);
    
    // Update alt text if title provided
    if (title && mediaItem.id) {
      try {
        await fetch(
          `${baseUrl}/wp-json/wp/v2/media/${mediaItem.id}`,
          {
            method: 'POST',
            headers: {
              'Authorization': authHeader,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              alt_text: title,
              title: title
            })
          }
        );
      } catch (altError) {
        console.warn('Failed to update alt text:', altError.message);
      }
    }

    res.json({ id: mediaItem.id, url: mediaItem.source_url });

  } catch (error) {
    console.error('WordPress media upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create WordPress post
app.post('/api/wordpress/posts', async (req, res) => {
  try {
    const { siteUrl, username, appPassword, title, content, featuredImageId, categoryId } = req.body;
    
    console.log('Create post request:', { siteUrl, title: title?.substring(0, 50), categoryId });
    
    if (!siteUrl || !username || !appPassword || !title || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const baseUrl = siteUrl.replace(/\/$/, '');
    const authHeader = getWpAuthHeader(username, appPassword);

    const postData = {
      title: title,
      content: content,
      status: 'draft'
    };

    if (featuredImageId) {
      postData.featured_media = featuredImageId;
    }

    if (categoryId) {
      postData.categories = [categoryId];
    }

    let response = await fetch(
      `${baseUrl}/wp-json/wp/v2/posts`,
      {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(postData),
        redirect: 'manual'
      }
    );

    // Handle redirects manually to preserve auth header
    if (response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) {
      const redirectUrl = response.headers.get('location');
      console.log('Redirect detected to:', redirectUrl);
      
      if (redirectUrl) {
        response = await fetch(redirectUrl, {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(postData)
        });
      }
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Post creation failed:', response.status, errorText.substring(0, 500));
      
      try {
        const errorData = JSON.parse(errorText);
        return res.status(response.status).json({ 
          error: errorData.message || 'Failed to create post' 
        });
      } catch {
        return res.status(response.status).json({ 
          error: `Failed to create post: ${response.status}` 
        });
      }
    }

    const post = await response.json();
    console.log('Post created successfully:', { id: post.id, link: post.link });
    
    res.json({
      id: post.id,
      link: post.link,
      adminLink: `${baseUrl}/wp-admin/post.php?post=${post.id}&action=edit`
    });

  } catch (error) {
    console.error('WordPress post creation error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Transcription proxy server running on port ${PORT}`);
});
