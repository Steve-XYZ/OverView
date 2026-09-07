/** Turns the `?error=` the callback sets into something a new user can act on. */

const MESSAGES: Readonly<Record<string, string>> = {
  state: "That sign-in link expired or was reused. Try again.",
  github: "GitHub could not complete the sign-in. Try again.",
  not_allowed: "That GitHub account is not on this deployment's allow list.",
  configuration: "This deployment is missing its GitHub sign-in configuration.",
};

const reason = new URLSearchParams(window.location.search).get("error");
const message = reason === null ? undefined : MESSAGES[reason];
const element = document.getElementById("error");
if (element !== null && message !== undefined) {
  element.textContent = message;
  element.hidden = false;
}
