import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async redirects() {
    // The staff dashboard moved from /dashboard to /admin-dashboard so that `/`
    // can host the public SmartRemit landing page. Keep a permanent redirect for
    // one release cycle so bookmarked URLs and — critically — in-flight KYC links
    // already shared with customers (/dashboard/customers/<phone>) don't 404.
    return [
      { source: '/dashboard', destination: '/admin-dashboard', permanent: true },
      {
        source: '/dashboard/:path*',
        destination: '/admin-dashboard/:path*',
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
