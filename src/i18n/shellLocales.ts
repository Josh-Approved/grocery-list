/**
 * Canonical translations of SHELL_STRINGS (Settings / About / common actions)
 * in the canon § Translations locale set (es, de, fr, it, pt-BR, ja). Because
 * the shell chrome is identical across every app, translating it ONCE here
 * localizes the Settings/About of every shell app — no per-app work. Synced by
 * `sync.mjs app-shell` (overwrite); edit HERE, never per app.
 *
 * Voice canon applies in every language: plain, calm, second person, no
 * marketing-ese. "Josh Approved" is a brand proper noun and never translates.
 * The app overlays its OWN domain strings per locale in `locales.ts`.
 *
 * Machine-drafted (Claude, $0 — canon § Translations). A native per-locale
 * layout/quality pass rides the Tier-3 capture machinery before these are
 * treated as final; the keys map 1:1 to shellStrings.ts.
 */

export const SHELL_LOCALES = {
  es: {
    common: { back: 'Atrás', cancel: 'Cancelar', done: 'Hecho', save: 'Guardar', delete: 'Eliminar', edit: 'Editar', rename: 'Cambiar nombre', add: 'Añadir', maybeLater: 'Quizás más tarde', notNow: 'Ahora no' },
    settings: { title: 'Ajustes', themeSystem: 'Sistema', themeLight: 'Claro', themeDark: 'Oscuro', language: 'Idioma', languageSystem: 'Sistema', languageSystemHint: 'Según tu teléfono', yourData: 'Tus datos', about: 'Acerca de', export: 'Exportar', import: 'Importar', nothingImported: 'No se importó nada.', couldntExport: 'No se pudo exportar.', couldntRead: 'No se pudo leer ese archivo.' },
    about: { support: 'Apoyar esta app', feedback: 'Enviar comentarios', review: 'Dejar una reseña', privacy: 'Privacidad', source: 'Código fuente', acknowledgements: 'Agradecimientos', version: 'Versión', oneLiner: 'Alternativas centradas en la privacidad a las apps de utilidades con muros de pago. Código abierto. Paga lo que quieras.', learnMore: 'Más información', learnMoreA11y: 'Más información en joshapproved.com' },
    donate: { body: '{app} no tiene anuncios ni suscripciones: lo mantienen las personas que lo usan. Si se ha ganado un lugar en tu día, tu apoyo lo mantiene en marcha.', supportA11y: 'Apoyar esta app, se abre en el navegador' },
    review: { title: '¿Te gusta {app}?', body: 'Una valoración rápida ayuda a que más personas descubran esta app.', leaveA11y: 'Dejar una reseña en la tienda de apps' },
    error: { title: 'Algo salió mal', body: 'La app tuvo un error inesperado. Vuelve a abrirla para continuar: tus datos están a salvo en este dispositivo.' },
    credits: { footnote: 'Los textos completos de las licencias están en el repositorio de cada proyecto.', linkHint: 'Abre la página del proyecto en el navegador' },
  },
  de: {
    common: { back: 'Zurück', cancel: 'Abbrechen', done: 'Fertig', save: 'Speichern', delete: 'Löschen', edit: 'Bearbeiten', rename: 'Umbenennen', add: 'Hinzufügen', maybeLater: 'Vielleicht später', notNow: 'Jetzt nicht' },
    settings: { title: 'Einstellungen', themeSystem: 'System', themeLight: 'Hell', themeDark: 'Dunkel', language: 'Sprache', languageSystem: 'System', languageSystemHint: 'Wie dein Telefon', yourData: 'Deine Daten', about: 'Über', export: 'Exportieren', import: 'Importieren', nothingImported: 'Nichts importiert.', couldntExport: 'Export fehlgeschlagen.', couldntRead: 'Diese Datei konnte nicht gelesen werden.' },
    about: { support: 'Diese App unterstützen', feedback: 'Feedback senden', review: 'Bewertung abgeben', privacy: 'Datenschutz', source: 'Quellcode', acknowledgements: 'Danksagungen', version: 'Version', oneLiner: 'Datenschutzfreundliche Alternativen zu Utility-Apps mit Bezahlschranke. Open Source. Zahl, was du willst.', learnMore: 'Mehr erfahren', learnMoreA11y: 'Mehr erfahren auf joshapproved.com' },
    donate: { body: '{app} hat keine Werbung und keine Abos – es lebt von den Menschen, die es nutzen. Wenn es einen Platz in deinem Alltag gefunden hat, hält deine Unterstützung es am Laufen.', supportA11y: 'Diese App unterstützen, wird im Browser geöffnet' },
    review: { title: 'Gefällt dir {app}?', body: 'Eine kurze Bewertung hilft mehr Menschen, diese App zu finden.', leaveA11y: 'Eine Bewertung im App-Store abgeben' },
    error: { title: 'Etwas ist schiefgelaufen', body: 'Die App hatte einen unerwarteten Fehler. Öffne sie erneut, um weiterzumachen – deine Daten sind auf diesem Gerät sicher.' },
    credits: { footnote: 'Die vollständigen Lizenztexte stehen im Repository des jeweiligen Projekts.', linkHint: 'Öffnet die Projektseite im Browser' },
  },
  fr: {
    common: { back: 'Retour', cancel: 'Annuler', done: 'Terminé', save: 'Enregistrer', delete: 'Supprimer', edit: 'Modifier', rename: 'Renommer', add: 'Ajouter', maybeLater: 'Plus tard', notNow: 'Pas maintenant' },
    settings: { title: 'Réglages', themeSystem: 'Système', themeLight: 'Clair', themeDark: 'Sombre', language: 'Langue', languageSystem: 'Système', languageSystemHint: 'Selon votre téléphone', yourData: 'Vos données', about: 'À propos', export: 'Exporter', import: 'Importer', nothingImported: "Rien n'a été importé.", couldntExport: "Échec de l'exportation.", couldntRead: 'Impossible de lire ce fichier.' },
    about: { support: 'Soutenir cette app', feedback: 'Envoyer un commentaire', review: 'Laisser un avis', privacy: 'Confidentialité', source: 'Code source', acknowledgements: 'Remerciements', version: 'Version', oneLiner: 'Des alternatives respectueuses de la vie privée aux applis utilitaires payantes. Open source. Payez ce que vous voulez.', learnMore: 'En savoir plus', learnMoreA11y: 'En savoir plus sur joshapproved.com' },
    donate: { body: "{app} n'a ni publicité ni abonnement : l'app vit grâce aux personnes qui l'utilisent. Si elle a trouvé sa place dans votre quotidien, votre soutien la fait vivre.", supportA11y: "Soutenir cette app, s'ouvre dans le navigateur" },
    review: { title: 'Vous aimez {app} ?', body: 'Une note rapide aide plus de monde à découvrir cette app.', leaveA11y: "Laisser un avis sur la boutique d'applications" },
    error: { title: 'Une erreur est survenue', body: "L'app a rencontré une erreur inattendue. Rouvrez-la pour continuer : vos données sont en sécurité sur cet appareil." },
    credits: { footnote: 'Les textes complets des licences se trouvent dans le dépôt de chaque projet.', linkHint: 'Ouvre la page du projet dans le navigateur' },
  },
  it: {
    common: { back: 'Indietro', cancel: 'Annulla', done: 'Fatto', save: 'Salva', delete: 'Elimina', edit: 'Modifica', rename: 'Rinomina', add: 'Aggiungi', maybeLater: 'Forse più tardi', notNow: 'Non ora' },
    settings: { title: 'Impostazioni', themeSystem: 'Sistema', themeLight: 'Chiaro', themeDark: 'Scuro', language: 'Lingua', languageSystem: 'Sistema', languageSystemHint: 'Come il telefono', yourData: 'I tuoi dati', about: 'Informazioni', export: 'Esporta', import: 'Importa', nothingImported: 'Niente importato.', couldntExport: 'Esportazione non riuscita.', couldntRead: 'Impossibile leggere il file.' },
    about: { support: 'Sostieni questa app', feedback: 'Invia un feedback', review: 'Lascia una recensione', privacy: 'Privacy', source: 'Codice sorgente', acknowledgements: 'Ringraziamenti', version: 'Versione', oneLiner: 'Alternative attente alla privacy alle app di utilità a pagamento. Open source. Paghi quanto vuoi.', learnMore: 'Scopri di più', learnMoreA11y: 'Scopri di più su joshapproved.com' },
    donate: { body: '{app} non ha pubblicità né abbonamenti: va avanti grazie alle persone che la usano. Se si è guadagnata un posto nella tua giornata, il tuo sostegno la mantiene in vita.', supportA11y: 'Sostieni questa app, si apre nel browser' },
    review: { title: 'Ti piace {app}?', body: 'Una valutazione veloce aiuta più persone a scoprire questa app.', leaveA11y: 'Lascia una recensione nello store' },
    error: { title: 'Qualcosa è andato storto', body: "L'app ha riscontrato un errore imprevisto. Riaprila per continuare: i tuoi dati sono al sicuro su questo dispositivo." },
    credits: { footnote: 'I testi completi delle licenze si trovano nel repository di ciascun progetto.', linkHint: 'Apre la pagina del progetto nel browser' },
  },
  'pt-BR': {
    common: { back: 'Voltar', cancel: 'Cancelar', done: 'Concluído', save: 'Salvar', delete: 'Excluir', edit: 'Editar', rename: 'Renomear', add: 'Adicionar', maybeLater: 'Talvez depois', notNow: 'Agora não' },
    settings: { title: 'Configurações', themeSystem: 'Sistema', themeLight: 'Claro', themeDark: 'Escuro', language: 'Idioma', languageSystem: 'Sistema', languageSystemHint: 'Conforme seu telefone', yourData: 'Seus dados', about: 'Sobre', export: 'Exportar', import: 'Importar', nothingImported: 'Nada importado.', couldntExport: 'Não foi possível exportar.', couldntRead: 'Não foi possível ler esse arquivo.' },
    about: { support: 'Apoiar este app', feedback: 'Enviar feedback', review: 'Avaliar', privacy: 'Privacidade', source: 'Código-fonte', acknowledgements: 'Agradecimentos', version: 'Versão', oneLiner: 'Alternativas com foco em privacidade a apps utilitários com paywall. Código aberto. Pague o quanto quiser.', learnMore: 'Saiba mais', learnMoreA11y: 'Saiba mais em joshapproved.com' },
    donate: { body: '{app} não tem anúncios nem assinaturas — ele se mantém com as pessoas que o usam. Se conquistou um lugar no seu dia, seu apoio o mantém funcionando.', supportA11y: 'Apoiar este app, abre no navegador' },
    review: { title: 'Curtindo o {app}?', body: 'Uma avaliação rápida ajuda mais pessoas a encontrar este app.', leaveA11y: 'Deixar uma avaliação na loja de apps' },
    error: { title: 'Algo deu errado', body: 'O app encontrou um erro inesperado. Reabra para continuar — seus dados estão seguros neste dispositivo.' },
    credits: { footnote: 'Os textos completos das licenças estão no repositório de cada projeto.', linkHint: 'Abre a página do projeto no navegador' },
  },
  ja: {
    common: { back: '戻る', cancel: 'キャンセル', done: '完了', save: '保存', delete: '削除', edit: '編集', rename: '名前を変更', add: '追加', maybeLater: 'あとで', notNow: '今はしない' },
    settings: { title: '設定', themeSystem: 'システム', themeLight: 'ライト', themeDark: 'ダーク', language: '言語', languageSystem: 'システム', languageSystemHint: 'スマホに合わせる', yourData: 'あなたのデータ', about: 'アプリについて', export: 'エクスポート', import: 'インポート', nothingImported: 'インポートされませんでした。', couldntExport: 'エクスポートできませんでした。', couldntRead: 'そのファイルを読み込めませんでした。' },
    about: { support: 'このアプリを支援', feedback: 'フィードバックを送る', review: 'レビューを書く', privacy: 'プライバシー', source: 'ソースコード', acknowledgements: '謝辞', version: 'バージョン', oneLiner: '有料の実用アプリに代わる、プライバシー重視のオープンソースアプリ。料金はお気持ちで。', learnMore: '詳しく見る', learnMoreA11y: 'joshapproved.com で詳しく見る' },
    donate: { body: '{app} には広告もサブスクもありません。使ってくれる人たちに支えられています。あなたの毎日に役立っているなら、その支援が続ける力になります。', supportA11y: 'このアプリを支援（ブラウザで開きます）' },
    review: { title: '{app} はいかがですか？', body: '簡単な評価が、より多くの人にこのアプリを届ける助けになります。', leaveA11y: 'アプリストアでレビューを書く' },
    error: { title: '問題が発生しました', body: 'アプリで予期しないエラーが発生しました。もう一度開くと続けられます。データはこの端末に安全に保存されています。' },
    credits: { footnote: '各ライセンスの全文は、それぞれのプロジェクトのリポジトリにあります。', linkHint: 'プロジェクトのページをブラウザで開きます' },
  },
} as const;
