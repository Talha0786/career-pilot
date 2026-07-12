import './globals.css';

export const metadata = {
  title: 'CareerPilot',
  description: 'CareerPilot AI — career operating system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans text-neutral-900">{children}</body>
    </html>
  );
}
