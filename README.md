# BOYO 🃏

**BOYO** is an online multiplayer card game where memory, strategy, and a little bit of luck determine who wins. Play with friends, keep track of hidden cards, use special abilities, and try to finish with the lowest score!

## 🎮 Features

- **Online Multiplayer** — Play with up to 8 players.
- **Hidden Cards** — Memorize your cards and make strategic decisions with incomplete information.
- **Special Card Abilities** — Peek at cards, inspect opponents' cards, and perform blind swaps.
- **TAP Mechanic** — React to matching ranks and discard eligible cards.
- **BOYO Call** — End the round when you think your score is low enough.
- **Customizable Games** — Configure the number of rounds.
- **Web-Based Gameplay** — Built with HTML, CSS, and JavaScript.

## 🃏 How to Play

1. Each player starts with four face-down cards.
2. At the beginning, each player looks at two of their cards before hiding them again.
3. Draw cards and decide whether to replace one of your own cards.
4. Use special abilities to gather information or swap cards strategically.
5. Call **TAP** when you spot an eligible matching rank.
6. Call **BOYO** when you believe your score is low enough.
7. After the final turns, the cards are revealed and scores are calculated.

The objective is to finish with the lowest cumulative score.

## 🂡 Card Values

| Card | Points |
|---|---:|
| Ace | 1 |
| Number cards | Face value |
| Jack / Queen | 10 |
| Red King | -2 |
| Black King | 10 |
| Joker | -1 |

## ⚡ Special Abilities

| Card | Ability |
|---|---|
| 7 | Peek at one of your own hidden cards |
| 9 | Peek at an opponent's hidden card |
| 10 | Blind swap one of your cards with an opponent's card |
| Black King | Access to all three special abilities |

*Rules and abilities may depend on the game's configured variant.*

## 🛠️ Built With

- **HTML5** — Game structure
- **CSS3** — Styling and responsive interface
- **JavaScript** — Game logic and interactions
- **Cloudflare Workers** — Multiplayer backend
- **Cloudflare Durable Objects** — Multiplayer room state and coordination

## 🚀 Getting Started

### Prerequisites

- A modern web browser
- A code editor such as Visual Studio Code
- Node.js and Wrangler if you're developing or deploying the Cloudflare backend

### Run Locally

1. Clone the repository:

   ```bash
   git clone https://github.com/YOUR_USERNAME/BOYO.git
   ```

2. Enter the project directory:

   ```bash
   cd BOYO
   ```

3. Open `index.html` in your browser, or use a local development server.

   **Note:** Online multiplayer requires the backend to be configured and running. Opening the HTML file alone may not provide full multiplayer functionality.

## 🌐 Deployment

BOYO is designed for web-based multiplayer gameplay.

Potential deployment options include:

- **Cloudflare Pages** — Hosting the frontend
- **Cloudflare Workers** — Running the multiplayer backend
- **CrazyGames** — Browser-game distribution
- **Google Play** — Potential Android release using Capacitor

Deployment requires the relevant services and configurations to be set up.

## 🔒 Security

- Do not commit API keys, access tokens, passwords, or private environment files.
- Store backend secrets using Cloudflare's secrets configuration.
- Validate important multiplayer actions on the server to prevent cheating.

## 📜 License

No license has been specified yet. All rights remain with the respective copyright holders unless a license is added to this repository.

---

**Made with ❤️ for card-game lovers.**

*Remember your cards. Outsmart your opponents. Call BOYO.*
