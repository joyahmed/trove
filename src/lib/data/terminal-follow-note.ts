// The "Follow folder" checkbox's note (plan 08 E1). The listing follows a `cd` only when the
// shell reports its folder (OSC 7, or OSC 9;9 on Windows). Trove never edits a shell's prompt
// to make it do so (no PROMPT_COMMAND, precmd or PowerShell prompt), so this says which shells
// already report and the one line that teaches the rest.
//
// ⚠️ Ubuntu's bash/zsh report only inside a VTE terminal: /etc/profile.d/vte.sh returns early
// unless VTE_VERSION is set, which it is only when Trove itself was started from one (GNOME
// Terminal, Tilix). The same for macOS Terminal's /etc/bashrc_Apple_Terminal (TERM_PROGRAM).
export const TERMINAL_FOLLOW_NOTE = [
  'Both ways: the shell moves to the folder you open, and a cd in the shell moves the listing.',
  'The second needs a shell that reports its folder (OSC 7). fish does out of the box; bash and zsh do through VTE (vte.sh) only when Trove was started from GNOME Terminal.',
  'bash, in ~/.bashrc: PROMPT_COMMAND=\'printf "\\e]7;file://%s%s\\e\\\\" "$HOSTNAME" "$PWD"\'',
  'zsh, in ~/.zshrc: precmd() { printf "\\e]7;file://%s%s\\e\\\\" "$HOST" "$PWD" }',
  'PowerShell, at the end of your prompt function: "$([char]27)]9;9;`"$($PWD.ProviderPath)`"$([char]27)\\"',
].join('\n');
