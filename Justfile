# Justfile for ctu-chatbot-plugin releases.
#
#   just bump            bump the patch version (1.0.0 -> 1.0.1)
#   just bump minor      bump the minor version  (1.0.0 -> 1.1.0)
#   just bump major      bump the major version  (1.0.0 -> 2.0.0)
#   just bump 1.2.3      set the version exactly to 1.2.3
#   just commit          create a tagged release commit (no push)
#
# Intended release flow:
#   just bump
#   just commit
#   git push origin main --tags

package := "ctu-chatbot-plugin/package.json"

# Bump (or set) the version in package.json.
bump target="patch":
	VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9.]*\)".*/\1/p' {{package}}) && \
	maj=${VERSION%%.*} && rest=${VERSION#*.} && min=${rest%%.*} && pat=${rest#*.} && \
	case "{{target}}" in \
		patch) NEW="$maj.$min.$((pat + 1))" ;; \
		minor) NEW="$maj.$((min + 1)).0" ;; \
		major) NEW="$((maj + 1)).0.0" ;; \
		*) if ! printf '%s' "{{target}}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then \
			echo "error: target must be patch, minor, major, or X.Y.Z (got: {{target}})" >&2; exit 1; fi; \
			NEW="{{target}}" ;; \
	esac && \
	sed -i "s/\"version\"[[:space:]]*:[[:space:]]*\"[0-9.]*\"/\"version\": \"$NEW\"/" {{package}} && \
	echo "bumped to $NEW"

# Create a tagged release commit. Does not push.
commit:
	VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9.]*\)".*/\1/p' {{package}}) && \
	git add -A && \
	git commit -m "release: v$VERSION" && \
	git tag -a -m "release: v$VERSION" "v$VERSION"
