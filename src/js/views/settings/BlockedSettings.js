import Component from '../../BaseComponent';
import Name from '../../components/Name';
import Nostr from '../../nostr/Nostr';
import SocialNetwork from '../../nostr/SocialNetwork';
import { translate as t } from '../../translations/Translation';

export default class BlockedSettings extends Component {
  constructor() {
    super();
    this.state.blockedUsers = [];
    this.id = 'settings';
  }
  render() {
    let hasBlockedUsers = false;
    const blockedUsers = Array.from(this.state.blockedUsers).map((user) => {
      const bech32 = Nostr.toNostrBech32Address(user, 'npub');
      if (bech32) {
        hasBlockedUsers = true;
        return (
          <p key={user}>
            <a href={`/${bech32}`}>
              <Name pub={user} />
            </a>
          </p>
        );
      }
    });

    return (
      <>
        <div class="centered-container">
          <h3>{t('blocked_users')}</h3>
          {hasBlockedUsers ? blockedUsers : t('none')}
        </div>
      </>
    );
  }
  componentDidMount() {
    SocialNetwork.getBlockedUsers((blockedUsers) => {
      this.setState({ blockedUsers });
    });
  }
}
