import { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Footer } from '../components/Footer'
import { GoToTop } from '../components/GoToTop'

function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-slate-950">
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10 sm:py-14">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-slate-500 transition-colors hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Dashboard
        </Link>
        <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{title}</h1>
        <p className="mt-1 text-[12px] text-slate-400 dark:text-slate-500">Last updated: {updated}</p>
        <div className="prose-sm mt-6 space-y-4 text-[13.5px] leading-relaxed text-slate-600 dark:text-slate-300">
          {children}
        </div>
      </main>
      <Footer />
      <GoToTop />
    </div>
  )
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="pt-2 text-[15px] font-semibold text-slate-900 dark:text-white">{children}</h2>
}

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="October 24, 2026">
      <H2>What we store</H2>
      <p>
        DB Remote keeps <strong>only dashboard session metadata</strong> (session identifiers, audit
        events, and — when you sign in to a dashboard account — your username and a password hash).
        Database connection strings, Neon API keys and passwords are kept <strong>in server memory
        only</strong> for the lifetime of your session and are wiped on disconnect, sign-out or
        idle expiry. They are never written to the dashboard database, never sent to the browser
        after connection, and never included in logs, analytics or URLs.
      </p>
      <H2>What never leaves your browser or server</H2>
      <p>
        The full SQL you run and the exact query parameters are used only to execute the query and
        answer the request. Passwords and raw credential material are redacted from every log line
        and every API response.
      </p>
      <H2>Third-party providers</H2>
      <p>
        Your queries run directly against the database or cloud provider you connected to (for
        example Neon). How that provider processes your data is governed by its own privacy policy —
        we cannot control what your provider does once the query reaches it.
      </p>
      <H2>Incidents</H2>
      <p>
        If you suspect a credential leak, disconnect the affected session first, then revoke or
        rotate the credential at the provider. See the Security &amp; Audit page and the operation
        docs shipped with this application for the full incident-response guide.
      </p>
      <H2>Contact</H2>
      <p>
        This dashboard is operated by the team behind{' '}
        <a
          href="https://projecthub-me.vercel.app"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          ProjectHub
        </a>
        . Contact the operator for privacy questions about this deployment.
      </p>
    </LegalPage>
  )
}

export function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="October 24, 2026">
      <H2>Acceptance</H2>
      <p>
        By using DB Remote you agree to these terms and to the privacy policy. This dashboard is a
        management surface for your database and cloud-provider resources; you remain responsible
        for the resources you connect and for the access you grant.
      </p>
      <H2>Use of the service</H2>
      <p>
        You may use the dashboard to connect to databases you own or are authorized to manage. SQL
        statements, schema changes and resource deletions you issue are executed with the
        permissions of the credentials you supplied — treat them accordingly.
      </p>
      <H2>Security responsibility</H2>
      <p>
        You are responsible for keeping your connection strings and API keys secret. No dashboard
        can stop someone who already holds a leaked database URL or API key from connecting to your
        resources directly. Rotate credentials when they may have been exposed.
      </p>
      <H2>Changes and availability</H2>
      <p>
        This service may change or be taken offline at any time. We do not guarantee uninterrupted
        availability or data integrity of the databases you manage through it.
      </p>
      <H2>Limitation of liability</H2>
      <p>
        To the maximum extent permitted by law, the operators are not liable for indirect or
        consequential damages arising from your use of the dashboard, including loss of data,
        interruption of service, or unauthorized access to your resources.
      </p>
      <H2>Contact</H2>
      <p>
        Operated by{' '}
        <a
          href="https://projecthub-me.vercel.app"
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          ProjectHub
        </a>
        .
      </p>
    </LegalPage>
  )
}