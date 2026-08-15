UPDATE communities
SET settings_json = json_set(
    settings_json,
    '$.reference_links',
    (
        SELECT json_group_array(json(
            CASE
                WHEN json_type(value, '$.id') IS NOT NULL THEN value
                WHEN json_type(value, '$.community_reference_link') IS NOT NULL THEN json_set(
                    json_remove(value, '$.community_reference_link'),
                    '$.id',
                    json_extract(value, '$.community_reference_link'),
                    '$.object',
                    'community_reference_link'
                )
                ELSE value
            END
        ))
        FROM json_each(settings_json, '$.reference_links')
    )
)
WHERE settings_json IS NOT NULL
  AND json_valid(settings_json)
  AND json_type(settings_json, '$.reference_links') = 'array';
