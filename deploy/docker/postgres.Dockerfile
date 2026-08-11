FROM postgres:17-bookworm

COPY --chmod=0555 deploy/docker/postgres-entrypoint.sh /usr/local/bin/moemail-postgres-entrypoint

ENTRYPOINT ["moemail-postgres-entrypoint"]
CMD ["postgres"]
