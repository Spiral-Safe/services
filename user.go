package solana_se

import (
	"github.com/go-webauthn/webauthn/webauthn"
)

type User struct {
	ID          string                `json:"id"`
	Username    string                `json:"username"`
	PubKey      string                `json:"pubKey"`
	Credentials []webauthn.Credential `json:"credentials"`
}

func (u User) WebAuthnID() []byte {
	if u.ID != "" {
		return []byte(u.ID)
	}
	return []byte(u.Username)
}

// WebAuthnName returns the user's username
func (u User) WebAuthnName() string {
	return u.Username
}

// WebAuthnDisplayName returns the user's display name
func (u User) WebAuthnDisplayName() string {
	return u.Username
}

// WebAuthnIcon is not (yet) implemented
func (u User) WebAuthnIcon() string {
	return ""
}

// AddCredential associates the credential to the user
func (u *User) AddCredential(cred webauthn.Credential) {
	u.Credentials = append(u.Credentials, cred)
}

// UpdateCredential persists the authenticator sign counter returned by a
// successful assertion, allowing the WebAuthn library to detect cloned keys.
func (u *User) UpdateCredential(updated webauthn.Credential) {
	for index := range u.Credentials {
		if string(u.Credentials[index].ID) == string(updated.ID) {
			u.Credentials[index] = updated
			return
		}
	}
}

// WebAuthnCredentials returns credentials owned by the user
func (u User) WebAuthnCredentials() []webauthn.Credential {
	return u.Credentials
}
