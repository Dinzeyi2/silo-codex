import getpass

from .config import token_hash


def main() -> None:
    token = getpass.getpass("Token: ")
    if len(token) < 32:
        raise SystemExit("token must contain at least 32 characters")
    print(token_hash(token))


if __name__ == "__main__":
    main()
