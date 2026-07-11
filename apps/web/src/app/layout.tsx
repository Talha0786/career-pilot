export const metadata = {
  title: 'CareerPilot',
  description: 'CareerPilot AI — career operating system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#f5f5f5' }}>
        {children}
      </body>
    </html>
  );
}
