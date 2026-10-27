<template>
  <main class="page">
    <h1>Privacy</h1>

    <section class="card grid">
      <h2>In short</h2>
      <p>
        Your pieces, recordings, stats and settings stay in your browser. Nothing you play is sent
        anywhere. There are no cookies, no analytics, no ads and no requests to third parties. The
        only personal data involved is what the web host logs when you load the site.
      </p>
    </section>

    <section class="card grid">
      <h2>Who is responsible</h2>
      <p>
        Tom Voet, a private, non-commercial project. Contact details are on
        <a href="https://tomvoet.dev">tomvoet.dev</a>.
      </p>
    </section>

    <section class="card grid">
      <h2>Hosting</h2>
      <p>
        The site is hosted on GitHub Pages by GitHub, Inc., 88 Colin P. Kelly Jr. Street, San
        Francisco, CA 94107, USA. When you open it, GitHub processes your IP address, the requested
        address, time, and your browser's user agent to deliver the files and to keep the service
        secure. GitHub may keep these logs for a limited time. I have no access to them.
      </p>
      <p>
        The legal basis is Art. 6(1)(f) GDPR: a website cannot be delivered without this. GitHub is
        certified under the EU-U.S. Data Privacy Framework, which covers the transfer to the USA.
        See the
        <a
          href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement"
          >GitHub privacy statement</a
        >.
      </p>
      <p>
        Fonts and piano samples are served from this site as well, so loading them does not contact
        anyone else.
      </p>
    </section>

    <section class="card grid">
      <h2>Stored in your browser</h2>
      <p>
        Imported pieces, practice passes, recordings and settings are kept in IndexedDB and local
        storage on your device. The app files and piano samples are cached so it works offline. None
        of this is transmitted. You can delete it at any time by clearing this site's data in your
        browser. Backups you save are files on your own computer.
      </p>
      <p>
        MIDI keyboard input and linked folders are handled entirely by your browser after you allow
        access. Files in a linked folder are only read locally.
      </p>
    </section>

    <section class="card grid">
      <h2>Your rights</h2>
      <p>
        Under the GDPR you have the right to access, rectification, erasure, restriction of
        processing and objection, and you can complain to a data protection supervisory authority.
        Since I do not store any data about you, requests about the server logs are best directed at
        GitHub.
      </p>
    </section>

    <p class="muted">Last updated October 2026.</p>
  </main>
</template>

<style scoped>
.page {
  max-width: 760px;
}

.grid {
  display: grid;
  gap: 12px;
}

h2 {
  margin: 0;
}

p {
  margin: 0;
  line-height: 1.6;
}
</style>
